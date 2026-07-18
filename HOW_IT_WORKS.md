# How This Works

A plain-language walkthrough of what was built, why, and exactly what the
code does. Read this alongside the actual files — every section points at
real file paths.

---

## 1. What problem is this solving?

Picture a SaaS API (think: something like the OpenAI or Anthropic API).
Customers ("tenants") call your API. You need to:

1. **Count** what each tenant uses (API calls, AI tokens) — this is *metering*.
2. **Stop** a tenant once they've used more than their plan allows — this is
   *quota enforcement*.
3. **Charge** them correctly, including for a Pro subscription via Stripe —
   this is *billing*.

The hard part isn't the happy path, it's the edge cases:

- A customer's app retries a failed request. Did we just charge them twice
  for the same thing?
- Two requests land in the same millisecond, both right at the customer's
  limit. Do both get let through, silently blowing past the quota?
- Stripe re-sends the same "subscription updated" webhook (it does this on
  purpose, for reliability). Did we just apply that update twice?
- Someone forges a fake webhook claiming a customer paid. Did we fall for it?

Every part of this project exists to answer those four questions with "no."

---

## 2. The three-layer architecture, and why it's shaped this way

```
        API layer                      Payment layer
  POST/GET /usage                    POST /checkout
  (src/routes/usage.ts)         POST /webhooks/stripe
                                 (src/routes/checkout.ts,
                                  src/routes/webhooks.ts)
            \                            /
             \                          /
              v                        v
                    Postgres
              (prisma/schema.prisma)
         the single source of truth
```

**The rule: the API layer and the Payment layer never call each other's
code.** The only thing they share is the database. Concretely:

- `src/routes/usage.ts` never imports anything from `checkout.ts` or
  `webhooks.ts`, and never talks to Stripe.
- `src/routes/checkout.ts` / `webhooks.ts` never import anything from
  `usage.ts`, and never compute quota or cost themselves.

**Why this matters in practice:** if metering logic had a bug, it can't take
billing down with it, and vice versa. It also means each half can be tested
completely independently — `tests/checkout.test.ts` and `tests/webhooks.test.ts`
mock Stripe out entirely and never touch metering code; `tests/usage.*.test.ts`
never touch Stripe at all. And because both layers read/write the *same*
Postgres rows instead of holding their own private in-memory state, there's
never a scenario where "the API layer thinks the plan is Free but the
payment layer thinks it's Pro" — there's exactly one row that says what the
plan is (`tenants.plan_id`), and everyone reads that row.

---

## 3. The database (`prisma/schema.prisma`)

Five tables, and each one exists to answer one of the four questions from
section 1:

| Table | Answers |
|---|---|
| `plans` | "What are the limits and price for Free / Pro?" |
| `tenants` | "Which plan is this customer on, and what's their Stripe customer id?" |
| `subscriptions` | "What billing period is this customer currently in, per Stripe?" |
| `usage_events` | "What did this tenant actually use, and have we already recorded this exact request before?" |
| `webhook_events` | "Have we already processed this exact Stripe webhook before?" |

Two columns do almost all of the heavy lifting in this whole project:

- `usage_events` has `UNIQUE (tenant_id, idempotency_key)` — a database-level
  guarantee that the same `(tenant, idempotency_key)` pair can physically
  never exist twice as two rows, no matter what the application code does.
- `webhook_events` has `UNIQUE (stripe_event_id)` — same idea, for Stripe
  events. The spec calls out that this must be a **separate** mechanism from
  the usage-events one, and it is: two different tables, two different
  unique constraints, protecting two different things (a client's metering
  request vs. a Stripe delivery).

Everything else in the code exists to use those two constraints correctly.

---

## 4. `POST /usage` — the core of the project

This is the one endpoint where getting the concurrency wrong would be a real
bug (double-billing or quota bypass), so it's worth going through slowly.
File: `src/routes/usage.ts:22-126`.

### What it needs to guarantee

> "Check quota AND write the usage_event in one atomic operation... prevent
> the race condition where two concurrent requests both slip past the
> limit... On duplicate idempotency_key, do NOT insert again — return the
> original result."

### Step by step, what the code does

```ts
const result = await prisma.$transaction(async (tx) => {
  const tenantRows = await tx.$queryRaw`
    SELECT id, plan_id FROM tenants WHERE id = ${tenant_id}::uuid FOR UPDATE
  `;
  ...
```

Everything from here to the end happens inside **one database transaction**
— either all of it commits, or none of it does. The first thing it does is
`SELECT ... FOR UPDATE` on the tenant's row.

`FOR UPDATE` is a **row lock**. It means: "I'm about to read this row to
make a decision — nobody else may touch this same row until I'm done
(committed or rolled back)." If a second request for the *same tenant*
arrives while the first is still inside this transaction, Postgres makes
the second request's `SELECT ... FOR UPDATE` **wait** — it physically
cannot proceed until the first transaction finishes. This is what turns two
simultaneous requests into two requests that happen one-after-another *as
far as this tenant's quota bookkeeping is concerned*, which is exactly what
removes the race condition. (Requests for *different* tenants don't block
each other — the lock is per-row, not global.)

```ts
  const existing = await tx.usageEvent.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: tenant_id, idempotencyKey: idempotency_key } },
  });
  if (existing) {
    return { event: existing, replay: true as const };
  }
```

Next, still holding the lock, it checks: has this exact
`(tenant_id, idempotency_key)` been recorded before? If yes, it returns the
**original** row immediately — no quota check, no new insert. This is what
makes retries safe: call it twice with the same key, you get the same
answer both times, and only one row ever exists.

```ts
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: tenantRow.plan_id } });
  const period = await getCurrentPeriod(tx, tenant_id);
  const limit = event_type === "api_call" ? plan.apiCallLimit : plan.aiTokenLimit;

  const agg = await tx.usageEvent.aggregate({
    where: { tenantId: tenant_id, eventType: event_type, createdAt: { gte: period.start, lt: period.end } },
    _sum: { quantity: true },
  });
  const used = agg._sum.quantity ?? 0;

  if (used + quantity > limit) {
    throw new QuotaExceededError({ eventType: event_type, used, limit, quantity });
  }
```

If it's genuinely a new request, it looks up the plan's limit, sums up
everything already recorded for this tenant *in the current billing period*
(`src/lib/period.ts` — explained in section 6), and checks whether adding
this new request would go over. If it would, it throws — which makes
Prisma **roll back the entire transaction**. Nothing gets written. The route
handler catches this specific error and returns `402`.

```ts
  const created = await tx.usageEvent.create({ data: { ... } });
  return { event: created, replay: false as const };
});
```

Otherwise, it inserts the row, and the transaction commits — releasing the
row lock, letting the next queued-up request for this tenant proceed.

### Why this actually prevents the race (a concrete example)

Say the limit is 1000 and current usage is 950. Two requests for 100 each
arrive at the same instant.

- **Without the lock**: both read "used = 950" before either writes. Both
  compute `950 + 100 = 1050`, which is... wait, both would actually see it's
  over in this example. Take a closer one: both read "used = 900" (limit
  1000), both compute `900 + 100 = 1000`, both think "that's fine, exactly
  at the limit," both insert. Real usage is now 1100 — 100 over the limit,
  and nobody's code was "wrong," they just both made the same
  correct-looking decision based on stale information.
- **With the lock**: request A acquires the lock, reads 900, inserts,
  commits, usage is now 1000. *Then* request B acquires the lock, reads
  1000 (not 900 — it had to wait, so it sees A's write), computes
  `1000 + 100 = 1100 > 1000`, and correctly rejects.

`tests/usage.quota.test.ts` has a test that fires 20 concurrent requests of
100 each (2000 total demand) against a 1000 limit and asserts **exactly**
10 succeed and the summed usage is **exactly** 1000 — not 1000-ish, exactly
1000. That test would fail intermittently without the row lock; it passes
reliably with it.

### The backstop

```ts
if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
```

This is defense-in-depth: if somehow two inserts for the same idempotency
key both reached the database (e.g. someone changes the transaction
isolation level later and reintroduces a gap), the `UNIQUE` constraint from
section 3 would reject the second `INSERT` outright at the database level.
This catch turns that into "return the existing row" instead of a 500
error. The row lock is the actual mechanism; this is just a safety net.

---

## 5. `GET /usage` — the cost rollup

File: `src/routes/usage.ts:135-190`. This one is much simpler — no writes,
no locking needed. It:

1. Looks up the tenant and their plan.
2. Figures out "the current billing period" (section 6).
3. Pulls every `usage_event` in that window.
4. Sums quantities per `event_type` for the `used` numbers.
5. Runs those same events through `computeCostCents()` (section 7) for the
   `cost` numbers.

If you pass `?event_type=api_call`, you get back exactly `{used, limit,
cost}` as the spec asked for. Without it, you get both `api_call` and
`ai_tokens` broken out plus a `total_cost_cents` — a superset, for
convenience.

---

## 6. What counts as "the current period"? (`src/lib/period.ts`)

Quota and cost are both scoped to "this billing period," not "all time."
That period comes from Stripe once a tenant has an active subscription
(`subscriptions.current_period_start` / `current_period_end`, kept in sync
by the webhook handler in section 8). Until then — e.g. a brand-new tenant
still on the Free plan who's never subscribed — there's no Stripe period to
use, so it falls back to the current calendar month.

---

## 7. Cost math (`src/lib/cost.ts`)

The spec has three specific requirements here, and each one maps to a
specific bit of code:

**"Pin the rates as constants, exact match test, no floating tolerance."**

```ts
export const RATES_CENTS = {
  API_CALL: 1,
  AI_TOKENS_PER_1000: { FRESH_INPUT: 3, CACHED_INPUT: 1, OUTPUT: 15 },
} as const;
```

Everything is in whole cents, and the token math is always
`(quantity * rate) / 1000` — as long as `quantity` is a multiple of 1000,
that division is exact, so there's never a rounding question for the
numbers the test suite uses. `tests/cost.test.ts` asserts with `.toBe(82)`,
not `.toBeCloseTo(82, 2)` — a real number, not "close enough."

**"Cached input tokens billed at a lower rate than fresh input tokens."**
`CACHED_INPUT: 1` vs `FRESH_INPUT: 3` — 3x cheaper. The `usage_events`
schema only has `event_type: 'api_call' | 'ai_tokens'`, so there's no column
for "was this cached." Instead, the caller puts it in the JSON `metadata`
column: `{"token_type": "cached_input"}`. `tokenRateCentsPer1000()` reads
that field to pick the rate.

**"Reasoning tokens counted as part of OUTPUT, not a separate category."**

```ts
function tokenRateCentsPer1000(tokenType) {
  switch (tokenType) {
    case "cached_input": return RATES_CENTS.AI_TOKENS_PER_1000.CACHED_INPUT;
    case "output":
    case "reasoning":
      return RATES_CENTS.AI_TOKENS_PER_1000.OUTPUT;   // <- both map here
    ...
```

`"reasoning"` and `"output"` hit the exact same `case` and get the exact
same rate. There's no separate "reasoning cost" anywhere in the return
value — `computeCostCents()` only ever returns `apiCallCostCents`,
`aiTokenCostCents`, and their sum. A test asserts a `reasoning` event and an
equal-quantity `output` event cost exactly the same, which is really a test
that this "no separate category" rule holds.

---

## 8. Stripe: `POST /checkout` and `POST /webhooks/stripe`

### `POST /checkout` (`src/routes/checkout.ts`)

This creates a **Stripe Checkout Session** — Stripe's own hosted payment
page. Your server never touches card numbers; it just asks Stripe "give me
a URL for this customer to pay for this plan," and hands that URL back.
Roughly:

1. Look up the tenant and the plan they want (`plan.stripe_price_id` — a
   price object you'd have created in your Stripe test dashboard).
2. If the tenant doesn't have a `stripe_customer_id` yet, create one in
   Stripe and save it (`tenants.stripe_customer_id`).
3. Ask Stripe for a Checkout Session for that customer + price, with
   `metadata: { tenant_id, plan_id }` attached.
4. Return the session's `url` to whoever called `/checkout`.

That `metadata` is important — it's the thread that lets the *webhook*
handler later know which of your tenants this Stripe event belongs to,
since Stripe only knows about its own customer/subscription ids, not yours.

### `POST /webhooks/stripe` (`src/routes/webhooks.ts`)

A **webhook** is Stripe calling *your* server, unprompted, to tell you
"something happened" (payment succeeded, subscription renewed, subscription
canceled). This is the only place subscription state actually gets written
— `/checkout` just starts the process, it never writes `subscriptionStatus`
or `subscriptions` rows itself.

Three things have to happen, strictly in this order:

**(a) Verify the signature — reject forgeries.**

```ts
event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
```

Every real webhook Stripe sends is signed with a secret only you and Stripe
know (`STRIPE_WEBHOOK_SECRET`). `constructEvent` recomputes that signature
from the raw request body and compares it to the `Stripe-Signature` header.
If they don't match — wrong secret, tampered body, or someone just curling
your endpoint pretending to be Stripe — it throws, and the handler returns
`400` before touching the database at all. (This is *why* the route uses
`express.raw()` instead of the normal JSON body parser — signature
verification needs the exact original bytes Stripe sent, not a
re-serialized JSON object, which can come out byte-for-byte different even
if it "looks the same.")

**(b) Deduplicate — Stripe is allowed to send the same event more than
once**, and your handler has to produce the same end state either way.

```ts
await prisma.$transaction(async (tx) => {
  await tx.webhookEvent.create({ data: { stripeEventId: event.id, eventType: event.type } });
  await applyStripeEvent(tx, event);
});
```

The insert into `webhook_events` and the actual tenant/subscription update
happen **in the same transaction**. If `event.id` was already recorded, the
`UNIQUE(stripe_event_id)` constraint makes that `create` fail, which rolls
back the *entire* transaction — so `applyStripeEvent` effectively never ran
for a duplicate. The outer `catch` recognizes that specific failure
(`P2002`) and returns `200` with `applied: false` — Stripe sees success (so
it stops retrying), but nothing was actually re-applied.

**(c) Apply the event** — `applyStripeEvent()` handles the three event
types the spec asks for:

- `checkout.session.completed` → mark the tenant active, set their plan
  from `session.metadata.plan_id`, save the Stripe customer id.
- `customer.subscription.updated` → upsert the `subscriptions` row (create
  it if this is the first time we've seen this subscription id, update it
  otherwise) with the latest status and billing period, and mirror the
  status onto `tenants.subscription_status`.
- `customer.subscription.deleted` → same upsert path, but force status to
  `"canceled"`.

---

## 9. What the tests actually prove

Running `npm test` runs everything below against a **real** Postgres
database (Docker), not a mock — the guarantees being tested (row locks,
unique constraints, transaction rollback) are properties of the real
database engine, so a mock wouldn't actually prove anything about them.

| File | What it proves |
|---|---|
| `tests/usage.idempotency.test.ts` | Same key sent twice sequentially, and 10x *simultaneously* via `Promise.all` → exactly one row exists either way |
| `tests/usage.quota.test.ts` | Exactly-at-limit is accepted, one-over is rejected with nothing written, and 20 simultaneous requests against a 1000 limit never let more than 1000 through |
| `tests/cost.test.ts` | A fixed input produces an exact expected total (`.toBe`, not approximate); reasoning tokens cost the same as output tokens; cached input is cheaper than fresh |
| `tests/webhooks.test.ts` | A forged signature is rejected with 400 and nothing is recorded; the same valid webhook delivered twice only changes tenant state once |
| `tests/usage.get.test.ts`, `tests/checkout.test.ts` | Rollup response shape, and checkout session creation (Stripe SDK mocked here — no real network call, this test is about *our* code, not Stripe's) |

---

## 10. Running it, recap

```powershell
docker compose up -d          # Postgres (dev db `billing` + test db `billing_test`)
npm install
npm run prisma:migrate:dev    # create tables
npm run prisma:seed           # insert Free + Pro plans
npm run dev                   # start the server (uses PORT from .env)
npm run demo                  # in another terminal: creates a tenant, prints curl commands
npm test                      # the real proof — runs everything in section 9
```

See `README.md` for the full setup (including Stripe CLI webhook
forwarding) — this file is about *why* the code is shaped the way it is,
not the setup steps.
