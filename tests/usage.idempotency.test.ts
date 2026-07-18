import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { createTenant } from "./helpers.js";

const app = createApp();

describe("POST /usage idempotency", () => {
  it("does not insert twice for a repeated idempotency_key sent sequentially", async () => {
    const tenant = await createTenant("Free");
    const key = "seq-key-1";

    const first = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 5, idempotency_key: key });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 5, idempotency_key: key });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.replay).toBe(true);

    const rows = await prisma.usageEvent.findMany({
      where: { tenantId: tenant.id, idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
  });

  it("does not insert twice for the same idempotency_key sent concurrently (Promise.all race)", async () => {
    const tenant = await createTenant("Free");
    const key = "concurrent-key-1";

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post("/usage")
          .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 5, idempotency_key: key })
      )
    );

    for (const res of responses) {
      expect([200, 201]).toContain(res.status);
    }

    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);

    const rows = await prisma.usageEvent.findMany({
      where: { tenantId: tenant.id, idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5);
  });

  it("replays the original result on duplicate key rather than re-checking quota", async () => {
    const tenant = await createTenant("Free");
    const key = "replay-key";

    const first = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 999, idempotency_key: key });
    expect(first.status).toBe(201);

    // Push right up to the limit with a different key so quota is now exhausted.
    await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 1, idempotency_key: "filler" });

    // Replaying the original key must still succeed even though quota is now full.
    const replay = await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 999, idempotency_key: key });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
  });
});
