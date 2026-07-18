import { Router } from "express";
import { prisma } from "../db.js";
import { stripe } from "../stripe.js";
import { config } from "../config.js";

export const checkoutRouter = Router();

/**
 * POST /checkout — creates a Stripe Checkout session for a tenant to
 * subscribe to a plan. Payment-layer only: it talks to Stripe and reads the
 * tenant/plan from Postgres, but the resulting subscription state is only
 * ever written back via the webhook handler (payment layer -> data layer),
 * never returned here and applied directly.
 */
checkoutRouter.post("/checkout", async (req, res) => {
  const { tenant_id, plan_id } = req.body ?? {};
  if (typeof tenant_id !== "string" || typeof plan_id !== "number") {
    return res
      .status(400)
      .json({ error: "invalid_request", message: "tenant_id (string) and plan_id (number) are required" });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenant_id } });
  if (!tenant) {
    return res.status(404).json({ error: "tenant_not_found" });
  }

  const plan = await prisma.plan.findUnique({ where: { id: plan_id } });
  if (!plan || !plan.stripePriceId) {
    return res.status(404).json({ error: "plan_not_found", message: "Plan has no Stripe price configured" });
  }

  let customerId = tenant.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: tenant.email,
      name: tenant.name,
      metadata: { tenant_id: tenant.id },
    });
    customerId = customer.id;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: config.checkoutSuccessUrl,
    cancel_url: config.checkoutCancelUrl,
    metadata: { tenant_id: tenant.id, plan_id: String(plan.id) },
    subscription_data: {
      metadata: { tenant_id: tenant.id, plan_id: String(plan.id) },
    },
  });

  return res.status(201).json({ checkout_url: session.url, session_id: session.id });
});
