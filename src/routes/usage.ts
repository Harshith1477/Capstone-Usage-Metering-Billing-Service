import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { validateUsageBody } from "../lib/validate.js";
import { getCurrentPeriod } from "../lib/period.js";
import { computeCostCents, type UsageEventLike } from "../lib/cost.js";
import { QuotaExceededError, TenantNotFoundError } from "../lib/errors.js";

export const usageRouter = Router();

/**
 * POST /usage — the metering endpoint.
 *
 * Quota check + write happen inside one DB transaction that takes a row
 * lock (`SELECT ... FOR UPDATE`) on the tenant row. That serializes
 * concurrent requests for the same tenant so two requests can never both
 * read "under quota" before either has written its usage_event — the
 * classic check-then-act race. The UNIQUE(tenant_id, idempotency_key)
 * constraint is a backstop for the same guarantee, not the primary
 * mechanism.
 */
usageRouter.post("/usage", async (req, res) => {
  const parsed = validateUsageBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: "invalid_request", message: parsed.error });
  }
  const { tenant_id, event_type, quantity, idempotency_key, metadata } = parsed.value;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const tenantRows = await tx.$queryRaw<{ id: string; plan_id: number }[]>`
        SELECT id, plan_id FROM tenants WHERE id = ${tenant_id}::uuid FOR UPDATE
      `;
      const tenantRow = tenantRows[0];
      if (!tenantRow) {
        throw new TenantNotFoundError(tenant_id);
      }

      const existing = await tx.usageEvent.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: tenant_id, idempotencyKey: idempotency_key },
        },
      });
      if (existing) {
        return { event: existing, replay: true as const };
      }

      const plan = await tx.plan.findUniqueOrThrow({ where: { id: tenantRow.plan_id } });
      const period = await getCurrentPeriod(tx, tenant_id);
      const limit = event_type === "api_call" ? plan.apiCallLimit : plan.aiTokenLimit;

      const agg = await tx.usageEvent.aggregate({
        where: {
          tenantId: tenant_id,
          eventType: event_type,
          createdAt: { gte: period.start, lt: period.end },
        },
        _sum: { quantity: true },
      });
      const used = agg._sum.quantity ?? 0;

      if (used + quantity > limit) {
        throw new QuotaExceededError({ eventType: event_type, used, limit, quantity });
      }

      const created = await tx.usageEvent.create({
        data: {
          tenantId: tenant_id,
          eventType: event_type,
          quantity,
          idempotencyKey: idempotency_key,
          metadata: metadata as Prisma.InputJsonValue | undefined,
        },
      });

      return { event: created, replay: false as const };
    });

    return res.status(result.replay ? 200 : 201).json({
      id: result.event.id,
      tenant_id: result.event.tenantId,
      event_type: result.event.eventType,
      quantity: result.event.quantity,
      idempotency_key: result.event.idempotencyKey,
      created_at: result.event.createdAt,
      replay: result.replay,
    });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return res.status(404).json({ error: "tenant_not_found", message: err.message });
    }
    if (err instanceof QuotaExceededError) {
      return res.status(402).json({
        error: "quota_exceeded",
        message: err.message,
        event_type: err.details.eventType,
        used: err.details.used,
        limit: err.details.limit,
      });
    }
    // Backstop: if a duplicate idempotency key ever slips past the row lock
    // (e.g. isolation level changes upstream), the unique constraint still
    // rejects the second insert — treat that as a replay, not an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.usageEvent.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: tenant_id, idempotencyKey: idempotency_key },
        },
      });
      if (existing) {
        return res.status(200).json({
          id: existing.id,
          tenant_id: existing.tenantId,
          event_type: existing.eventType,
          quantity: existing.quantity,
          idempotency_key: existing.idempotencyKey,
          created_at: existing.createdAt,
          replay: true,
        });
      }
    }
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /usage?tenant_id=...&event_type=api_call|ai_tokens
 *
 * Rolls up a tenant's usage_events for the current billing period. Without
 * event_type, returns both api_call and ai_tokens breakdowns plus total
 * cost. With event_type, returns the {used, limit, cost} shape directly.
 */
usageRouter.get("/usage", async (req, res) => {
  const tenantId = req.query.tenant_id;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    return res.status(400).json({ error: "invalid_request", message: "tenant_id is required" });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } });
  if (!tenant) {
    return res.status(404).json({ error: "tenant_not_found" });
  }

  const period = await getCurrentPeriod(prisma, tenantId);

  const events = await prisma.usageEvent.findMany({
    where: { tenantId, createdAt: { gte: period.start, lt: period.end } },
    select: { eventType: true, quantity: true, metadata: true },
  });

  const asUsageEvents: UsageEventLike[] = events.map((e) => ({
    eventType: e.eventType as "api_call" | "ai_tokens",
    quantity: e.quantity,
    metadata: e.metadata as UsageEventLike["metadata"],
  }));

  const apiCallUsed = asUsageEvents
    .filter((e) => e.eventType === "api_call")
    .reduce((sum, e) => sum + e.quantity, 0);
  const aiTokenUsed = asUsageEvents
    .filter((e) => e.eventType === "ai_tokens")
    .reduce((sum, e) => sum + e.quantity, 0);

  const cost = computeCostCents(asUsageEvents);

  const eventTypeParam = req.query.event_type;
  if (eventTypeParam !== undefined) {
    if (eventTypeParam === "api_call") {
      return res.json({ used: apiCallUsed, limit: tenant.plan.apiCallLimit, cost: cost.apiCallCostCents });
    }
    if (eventTypeParam === "ai_tokens") {
      return res.json({ used: aiTokenUsed, limit: tenant.plan.aiTokenLimit, cost: cost.aiTokenCostCents });
    }
    return res.status(400).json({ error: "invalid_request", message: "invalid event_type" });
  }

  return res.json({
    tenant_id: tenantId,
    period: { start: period.start, end: period.end },
    api_calls: { used: apiCallUsed, limit: tenant.plan.apiCallLimit },
    ai_tokens: { used: aiTokenUsed, limit: tenant.plan.aiTokenLimit },
    cost: {
      api_call_cost_cents: cost.apiCallCostCents,
      ai_token_cost_cents: cost.aiTokenCostCents,
      total_cost_cents: cost.totalCostCents,
    },
  });
});
