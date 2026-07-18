import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { stripe } from "../src/stripe.js";
import { config } from "../src/config.js";
import { createTenant } from "./helpers.js";

const app = createApp();

function buildEvent(id: string, type: string, object: Record<string, unknown>) {
  return {
    id,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

function sign(payload: string) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripeWebhookSecret });
}

describe("POST /webhooks/stripe", () => {
  it("rejects a forged signature with 400 and does not record the event", async () => {
    const payload = JSON.stringify(
      buildEvent("evt_forged_1", "customer.subscription.updated", {
        id: "sub_forged",
        customer: "cus_forged",
        status: "active",
        current_period_start: 1000,
        current_period_end: 2000,
      })
    );

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeef")
      .send(payload);

    expect(res.status).toBe(400);

    const rows = await prisma.webhookEvent.findMany({ where: { stripeEventId: "evt_forged_1" } });
    expect(rows).toHaveLength(0);
  });

  it("applies a valid checkout.session.completed webhook and updates the tenant", async () => {
    const tenant = await createTenant("Free");
    const proPlan = await prisma.plan.findUniqueOrThrow({ where: { name: "Pro" } });

    const payload = JSON.stringify(
      buildEvent("evt_checkout_1", "checkout.session.completed", {
        id: "cs_test_1",
        customer: "cus_test_1",
        metadata: { tenant_id: tenant.id, plan_id: String(proPlan.id) },
      })
    );

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    const updated = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(updated.subscriptionStatus).toBe("active");
    expect(updated.planId).toBe(proPlan.id);
    expect(updated.stripeCustomerId).toBe("cus_test_1");
  });

  it("applies the same valid webhook only once when delivered twice", async () => {
    const tenant = await createTenant("Free");

    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify(
      buildEvent("evt_sub_updated_1", "customer.subscription.updated", {
        id: "sub_test_1",
        customer: "cus_test_2",
        status: "active",
        current_period_start: now,
        current_period_end: now + 30 * 24 * 60 * 60,
        metadata: { tenant_id: tenant.id },
      })
    );
    const signature = sign(payload);

    const first = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature)
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);

    const second = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.applied).toBe(false);

    const webhookRows = await prisma.webhookEvent.findMany({
      where: { stripeEventId: "evt_sub_updated_1" },
    });
    expect(webhookRows).toHaveLength(1);

    const subscriptionRows = await prisma.subscription.findMany({
      where: { stripeSubscriptionId: "sub_test_1" },
    });
    expect(subscriptionRows).toHaveLength(1);
  });

  it("marks the tenant canceled on customer.subscription.deleted", async () => {
    const tenant = await createTenant("Free");
    const now = Math.floor(Date.now() / 1000);

    // First put the tenant into an active subscription state.
    const activePayload = JSON.stringify(
      buildEvent("evt_sub_active_1", "customer.subscription.updated", {
        id: "sub_test_2",
        customer: "cus_test_3",
        status: "active",
        current_period_start: now,
        current_period_end: now + 30 * 24 * 60 * 60,
        metadata: { tenant_id: tenant.id },
      })
    );
    await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", sign(activePayload))
      .send(activePayload);

    const deletePayload = JSON.stringify(
      buildEvent("evt_sub_deleted_1", "customer.subscription.deleted", {
        id: "sub_test_2",
        customer: "cus_test_3",
        status: "canceled",
        current_period_start: now,
        current_period_end: now + 30 * 24 * 60 * 60,
        metadata: { tenant_id: tenant.id },
      })
    );
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", sign(deletePayload))
      .send(deletePayload);

    expect(res.status).toBe(200);
    const updated = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(updated.subscriptionStatus).toBe("canceled");
  });
});
