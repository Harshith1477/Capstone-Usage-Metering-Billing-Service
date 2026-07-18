import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createTenant } from "./helpers.js";

const app = createApp();

describe("GET /usage", () => {
  it("rolls up used/limit/cost for the current period", async () => {
    const tenant = await createTenant("Free");

    await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 10, idempotency_key: "a" });
    await request(app).post("/usage").send({
      tenant_id: tenant.id,
      event_type: "ai_tokens",
      quantity: 4000,
      idempotency_key: "b",
      metadata: { token_type: "fresh_input" },
    });

    const res = await request(app).get("/usage").query({ tenant_id: tenant.id });
    expect(res.status).toBe(200);
    expect(res.body.api_calls).toEqual({ used: 10, limit: 1000 });
    expect(res.body.ai_tokens).toEqual({ used: 4000, limit: 100000 });
    expect(res.body.cost.api_call_cost_cents).toBe(10);
    expect(res.body.cost.ai_token_cost_cents).toBe(12);
    expect(res.body.cost.total_cost_cents).toBe(22);
  });

  it("returns the {used, limit, cost} shape when event_type is specified", async () => {
    const tenant = await createTenant("Free");
    await request(app)
      .post("/usage")
      .send({ tenant_id: tenant.id, event_type: "api_call", quantity: 3, idempotency_key: "x" });

    const res = await request(app)
      .get("/usage")
      .query({ tenant_id: tenant.id, event_type: "api_call" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ used: 3, limit: 1000, cost: 3 });
  });

  it("404s for an unknown tenant", async () => {
    const res = await request(app)
      .get("/usage")
      .query({ tenant_id: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });
});
