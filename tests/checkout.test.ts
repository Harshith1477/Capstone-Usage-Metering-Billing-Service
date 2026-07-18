import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/stripe.js", () => ({
  stripe: {
    customers: {
      create: vi.fn().mockResolvedValue({ id: "cus_mock_1" }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "cs_mock_1", url: "https://checkout.stripe.com/mock" }),
      },
    },
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { createTenant } = await import("./helpers.js");

const app = createApp();

describe("POST /checkout", () => {
  it("creates a Stripe customer + checkout session and persists the customer id", async () => {
    const tenant = await createTenant("Free");
    const proPlan = await prisma.plan.findUniqueOrThrow({ where: { name: "Pro" } });

    const res = await request(app)
      .post("/checkout")
      .send({ tenant_id: tenant.id, plan_id: proPlan.id });

    expect(res.status).toBe(201);
    expect(res.body.checkout_url).toBe("https://checkout.stripe.com/mock");

    const updated = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(updated.stripeCustomerId).toBe("cus_mock_1");
  });

  it("404s for an unknown tenant", async () => {
    const proPlan = await prisma.plan.findUniqueOrThrow({ where: { name: "Pro" } });
    const res = await request(app)
      .post("/checkout")
      .send({ tenant_id: "00000000-0000-0000-0000-000000000000", plan_id: proPlan.id });
    expect(res.status).toBe(404);
  });
});
