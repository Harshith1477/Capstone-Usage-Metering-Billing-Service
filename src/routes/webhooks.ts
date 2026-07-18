import express, { Router } from "express";
import { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "../db.js";
import { stripe } from "../stripe.js";
import { config } from "../config.js";

export const webhooksRouter = Router();

/**
 * POST /webhooks/stripe
 *
 * Order matters and is enforced top-to-bottom:
 *  (a) verify the Stripe signature — reject with 400 if it doesn't check out
 *  (b) atomically claim the event id in webhook_events (separate idempotency
 *      mechanism from usage_events' idempotency_key) — a duplicate delivery
 *      hits the UNIQUE(stripe_event_id) constraint, the transaction rolls
 *      back, and we return 200 having applied nothing
 *  (c) update the tenant's plan/status and upsert the subscriptions row,
 *      in the same transaction as the claim so a crash between claiming and
 *      applying can never happen
 *
 * Needs the raw request body for signature verification, so this route is
 * mounted with express.raw() ahead of the app's global express.json().
 */
webhooksRouter.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      return res.status(400).json({ error: "missing_signature" });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch {
      return res.status(400).json({ error: "invalid_signature" });
    }

    let applied = true;
    try {
      await prisma.$transaction(async (tx) => {
        // Unique constraint on stripe_event_id makes this claim atomic: a
        // second concurrent/duplicate delivery fails here, which aborts the
        // whole transaction below before any tenant/subscription write
        // happens.
        await tx.webhookEvent.create({
          data: { stripeEventId: event.id, eventType: event.type },
        });
        await applyStripeEvent(tx, event);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        applied = false;
      } else {
        // eslint-disable-next-line no-console
        console.error("Failed to process Stripe webhook", err);
        return res.status(500).json({ error: "internal_error" });
      }
    }

    return res.status(200).json({ received: true, applied });
  }
);

async function applyStripeEvent(tx: Prisma.TransactionClient, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = session.metadata?.tenant_id;
      if (!tenantId) return;

      const planId = session.metadata?.plan_id ? Number(session.metadata.plan_id) : undefined;

      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: "active",
          ...(planId !== undefined ? { planId } : {}),
          ...(typeof session.customer === "string" ? { stripeCustomerId: session.customer } : {}),
        },
      });
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const tenantId =
        subscription.metadata?.tenant_id ?? (await findTenantIdByCustomer(tx, subscription.customer));
      if (!tenantId) return;

      const status = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;

      await tx.subscription.upsert({
        where: { stripeSubscriptionId: subscription.id },
        create: {
          tenantId,
          stripeSubscriptionId: subscription.id,
          status,
          currentPeriodStart: new Date(subscription.current_period_start * 1000),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
        update: {
          status,
          currentPeriodStart: new Date(subscription.current_period_start * 1000),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      });

      await tx.tenant.update({
        where: { id: tenantId },
        data: { subscriptionStatus: status },
      });
      return;
    }
    default:
      return;
  }
}

async function findTenantIdByCustomer(
  tx: Prisma.TransactionClient,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): Promise<string | undefined> {
  const customerId = typeof customer === "string" ? customer : customer?.id;
  if (!customerId) return undefined;
  const tenant = await tx.tenant.findUnique({ where: { stripeCustomerId: customerId } });
  return tenant?.id;
}
