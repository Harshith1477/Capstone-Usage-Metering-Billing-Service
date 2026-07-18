# Usage Metering, Quota Enforcement & Stripe Billing (test mode)

Backend-only service: meters usage, enforces per-plan quotas, computes cost,
and syncs subscription state from Stripe via signed, deduped webhooks.

## Architecture

Three layers that only ever communicate through Postgres — never by calling
into each other's code or process:

```
┌─────────────────┐        ┌─────────────────┐
│   API layer      │        │  Payment layer   │
│  POST/GET /usage │        │ /checkout        │
│  (metering, quota,│       │ /webhooks/stripe │
│   cost)          │        │ (Stripe sync)    │
└────────┬─────────┘        └────────┬─────────┘
         │                           │
         └───────────┬───────────────┘
                      ▼
              ┌───────────────┐
              │  Data layer   │
              │  Postgres     │
              │ (single source│
              │  of truth)    │
              └───────────────┘
```

1. **API layer** (`src/routes/usage.ts`) — meters usage, enforces quota,
   computes cost. Reads plan limits and writes `usage_events` directly
   against Postgres. It never calls Stripe and never imports anything from
   the payment layer.
2. **Payment layer** (`src/routes/checkout.ts`, `src/routes/webhooks.ts`) —
   talks to Stripe (Checkout session creation, webhook verification) and
   writes the result — plan, subscription status, billing period — back to
   Postgres. It never calls the API layer or recomputes quota/cost itself.
3. **Data layer** (Postgres, `prisma/schema.prisma`) — the single source of
   truth both layers read from and write to. Neither layer is ever allowed
   to hold in-memory state the other depends on; if the process restarts,
   Postgres is what's still correct.

**Why they never call each other directly:** if the API layer called the
payment layer's code to, say, look up plan status, a bug or outage in Stripe
integration would break usage metering — and if the payment layer called
into metering to react to usage, a bug in quota logic would break billing
sync. Routing everything through Postgres means each layer's correctness
only depends on the database, which is the thing that's actually persisted,
transactional, and testable in isolation. It also means the payment layer
can be entirely mocked out (see `tests/checkout.test.ts`) without touching
metering logic, and vice versa.

### Where each guarantee lives

| Guarantee | Mechanism | File |
|---|---|---|
| No double-charge on repeated `POST /usage` | `UNIQUE(tenant_id, idempotency_key)` on `usage_events`, checked inside the same transaction as the quota check | `src/routes/usage.ts` |
| No race between two concurrent requests both slipping under quota | `SELECT ... FOR UPDATE` row lock on the `tenants` row, taken before the quota check, held until commit — serializes concurrent writers per tenant | `src/routes/usage.ts` |
| Quota check + write are atomic | Both happen inside one `prisma.$transaction` | `src/routes/usage.ts` |
| Webhook signature can't be forged | `stripe.webhooks.constructEvent` verifies the `Stripe-Signature` header against the raw body before any DB write; invalid → `400`, nothing recorded | `src/routes/webhooks.ts` |
| Webhook applied at most once, even if Stripe redelivers | `UNIQUE(stripe_event_id)` on `webhook_events` — a **separate** idempotency mechanism from `usage_events`' idempotency key, claimed in the same transaction that applies the tenant/subscription update, so a duplicate delivery rolls back before touching tenant state | `src/routes/webhooks.ts` |

## Data model

Exactly five tables (`prisma/schema.prisma`):

- `plans` — `id, name, api_call_limit, ai_token_limit, price_cents, stripe_price_id`
- `tenants` — `id (uuid), name, email (unique), plan_id, stripe_customer_id (unique), subscription_status, created_at, updated_at`
- `subscriptions` — `id (uuid), tenant_id, stripe_subscription_id (unique), status, current_period_start, current_period_end`
- `usage_events` — `id (uuid), tenant_id, event_type ('api_call'|'ai_tokens'), quantity, idempotency_key, metadata (jsonb), created_at`, with `UNIQUE(tenant_id, idempotency_key)`
- `webhook_events` — `id (uuid), stripe_event_id (unique), event_type, processed_at`

Seeded plans: **Free** (1,000 api_call limit / 100,000 ai_token limit) and
**Pro** (100,000 api_call limit / 10,000,000 ai_token limit).

## Cost math

Rates are pinned constants in `src/lib/cost.ts` (illustrative test-mode
figures, not real prices), all integer cents so cost math is exact —
`tests/cost.test.ts` asserts exact totals with `toBe`, no tolerance:

- `api_call`: 1 cent/call
- `ai_tokens`, fresh input: 3 cents / 1,000 tokens
- `ai_tokens`, cached input: 1 cent / 1,000 tokens (cheaper than fresh)
- `ai_tokens`, output (**includes reasoning tokens**): 15 cents / 1,000 tokens

Since `usage_events.event_type` only distinguishes `api_call` from
`ai_tokens` (per the fixed schema), token subtype is carried in
`metadata.token_type` on `ai_tokens` events: `"fresh_input" | "cached_input"
| "output" | "reasoning"`. Reasoning tokens are billed at the output rate
and are **not** tracked or billed as a separate category — that's enforced
in `tokenRateCentsPer1000()` in `src/lib/cost.ts`, and verified directly by
a test that asserts a `reasoning` event costs exactly the same as an
equivalent-quantity `output` event.

## Quota enforcement

`POST /usage` returns `402 Payment Required` (chosen over `429` since this
is a billing quota, not a rate limit) with the tenant's current usage and
limit in the body, and writes nothing on rejection.

## Billing period

Quota and `GET /usage` roll-ups use the tenant's active `subscriptions` row
(`current_period_start`/`current_period_end`, kept in sync from Stripe) as
the current period. Tenants with no subscription yet (e.g. still on Free,
never checked out) fall back to the current calendar month
(`src/lib/period.ts`).

## Running it

### 1. Start Postgres

```bash
docker compose up -d
```

This starts one Postgres container exposing port `5433` with two databases:
`billing` (dev) and `billing_test` (tests — created by
`docker/init-test-db.sql`).

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in Stripe **test-mode** keys (`sk_test_...`) from
https://dashboard.stripe.com/test/apikeys if you want to exercise
`/checkout` against real Stripe, and a webhook secret from `stripe listen`
(step 5). Never put live keys here.

### 3. Install, migrate, seed

```bash
npm install
npm run prisma:migrate:dev   # applies prisma/migrations, generates client
npm run prisma:seed          # seeds Free + Pro plans
```

### 4. Run the server

```bash
npm run dev
```

### 5. Forward Stripe webhooks locally (Stripe CLI)

```bash
stripe login                 # once
stripe listen --forward-to localhost:3000/webhooks/stripe
```

`stripe listen` prints a `whsec_...` value — put that in `.env` as
`STRIPE_WEBHOOK_SECRET` and restart the server. Trigger test events with:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
```

Note: real `stripe trigger` events won't carry your tenant's
`metadata.tenant_id` unless they originate from a real `/checkout` session
created against your test tenant — for a full local loop, hit `/checkout`
for a real tenant first, complete it in the Checkout UI it returns, then let
the forwarded webhooks land.

### 6. Try the metering endpoint

`npm run demo` creates a demo tenant on the Free plan and prints ready-to-run
curl commands (including a duplicate-idempotency-key replay and an
over-quota request):

```bash
npm run demo
```

## Testing

```bash
npm test
```

`pretest` pushes the schema to `billing_test` (via `TEST_DATABASE_URL`)
before Vitest runs — no separate migration step needed for tests. Tests run
against a real Postgres instance (not mocks) since the guarantees under
test (row locking, unique constraints, transaction rollback) are properties
of the real database engine.

Covers, per the spec's definition of done:

- `tests/usage.idempotency.test.ts` — same `idempotency_key` sent twice
  sequentially, and 10x concurrently via `Promise.all`: exactly one row in
  `usage_events` either way.
- `tests/usage.quota.test.ts` — at-limit accepted, over-by-one rejected with
  nothing written, and a 20-way concurrent race against a 1,000-unit limit
  that never lets more than 1,000 units through.
- `tests/cost.test.ts` — exact-match cost assertions (`toBe`, not
  `toBeCloseTo`), including cached-vs-fresh-input pricing and reasoning
  tokens folding into the output rate.
- `tests/webhooks.test.ts` — forged signature rejected with `400` and
  nothing recorded; a valid webhook sent twice only applies its effect
  once (`applied: true` then `applied: false`, one `webhook_events` row).
- `tests/usage.get.test.ts`, `tests/checkout.test.ts` — rollup shape and
  checkout session creation (Stripe SDK mocked so no network call is made).

## Project layout

```
prisma/schema.prisma      five tables, exactly as specified
prisma/seed.ts             seeds Free + Pro plans
src/routes/usage.ts        API layer: POST/GET /usage
src/routes/checkout.ts     Payment layer: POST /checkout
src/routes/webhooks.ts     Payment layer: POST /webhooks/stripe
src/lib/cost.ts            pinned cost rates + computeCostCents()
src/lib/period.ts          current billing period resolution
src/db.ts                  Prisma client (the only DB access point)
tests/                     Vitest + Supertest, against real Postgres
```
