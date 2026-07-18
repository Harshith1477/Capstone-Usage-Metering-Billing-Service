import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { createTenant } from "./helpers.js";

const app = createApp();

describe("POST /usage quota enforcement", () => {
  it("accepts a request that lands exactly at the limit", async () => {
    const tenant = await createTenant("Free"); // api_call_limit = 1000
    const res = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 1000, idempotency_key: "at-limit" });
    expect(res.status).toBe(201);
  });

  it("rejects a request that would exceed the limit by one, and writes nothing", async () => {
    const tenant = await createTenant("Free");
    await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 1000, idempotency_key: "fill" });

    const res = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 1, idempotency_key: "overflow" });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("quota_exceeded");

    const rows = await prisma.usageEvent.findMany({
      where: { tenantId: tenant.id, idempotencyKey: "overflow" },
    });
    expect(rows).toHaveLength(0);
  });

  it("rejects a single over-limit request outright and writes nothing", async () => {
    const tenant = await createTenant("Free");
    const res = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 1001, idempotency_key: "too-big" });

    expect(res.status).toBe(402);
    const rows = await prisma.usageEvent.findMany({ where: { tenantId: tenant.id } });
    expect(rows).toHaveLength(0);
  });

  it("never lets concurrent requests push total usage past the limit", async () => {
    const tenant = await createTenant("Free"); // api_call_limit = 1000

    // 20 concurrent requests of 100 each = 2000 total demand against a 1000
    // limit. Without the row lock, races could let more than 10 through.
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app)
          .post("/usage")
          .send({
            tenant_id: tenant.id,
            event_type: "api_call",
            quantity: 100,
            idempotency_key: `race-${i}`,
          })
      )
    );

    const succeeded = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 402);
    expect(succeeded.length + rejected.length).toBe(20);
    expect(succeeded.length).toBe(10);
    expect(rejected.length).toBe(10);

    const agg = await prisma.usageEvent.aggregate({
      where: { tenantId: tenant.id, eventType: "api_call" },
      _sum: { quantity: true },
    });
    expect(agg._sum.quantity).toBe(1000);
  });
});
