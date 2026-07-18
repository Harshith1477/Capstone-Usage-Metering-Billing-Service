import Stripe from "stripe";
import { config } from "dotenv";

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const secret = process.env.STRIPE_WEBHOOK_SECRET;
const baseUrl = `http://localhost:${process.env.PORT ?? 3900}/webhooks/stripe`;

const TENANT_ID = "e7dac087-2ca8-4e6d-8fea-d4b69928183e";
const PLAN_ID = "2";
const CUSTOMER_ID = "cus_UuNJmUFimIngo3";
const SUBSCRIPTION_ID = "sub_demo_" + Date.now();

function buildEvent(id, type, object) {
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

async function send(label, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload,
  });
  const body = await res.json();
  console.log(`${label}: HTTP ${res.status}`, body);
}

const now = Math.floor(Date.now() / 1000);

await send(
  "checkout.session.completed",
  buildEvent("evt_demo_checkout_" + Date.now(), "checkout.session.completed", {
    id: "cs_demo_" + Date.now(),
    customer: CUSTOMER_ID,
    metadata: { tenant_id: TENANT_ID, plan_id: PLAN_ID },
  })
);

await send(
  "customer.subscription.updated",
  buildEvent("evt_demo_sub_" + Date.now(), "customer.subscription.updated", {
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    status: "active",
    current_period_start: now,
    current_period_end: now + 30 * 24 * 60 * 60,
    metadata: { tenant_id: TENANT_ID },
  })
);

// Same event id sent twice — proves dedupe on the live server, not just in tests.
await send("checkout.session.completed (dup, 1st delivery)", buildEvent("evt_demo_checkout_dupe", "checkout.session.completed", {
  id: "cs_demo_dupe",
  customer: CUSTOMER_ID,
  metadata: { tenant_id: TENANT_ID, plan_id: PLAN_ID },
}));
await send("checkout.session.completed (dup, 2nd delivery, should applied:false)", buildEvent("evt_demo_checkout_dupe", "checkout.session.completed", {
  id: "cs_demo_dupe",
  customer: CUSTOMER_ID,
  metadata: { tenant_id: TENANT_ID, plan_id: PLAN_ID },
}));

// Forged signature — proves rejection on the live server.
const forgedPayload = JSON.stringify(buildEvent("evt_demo_forged", "customer.subscription.updated", {
  id: "sub_forged", customer: CUSTOMER_ID, status: "active",
  current_period_start: now, current_period_end: now + 1000,
}));
const forgedRes = await fetch(baseUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeef" },
  body: forgedPayload,
});
console.log("forged signature: HTTP", forgedRes.status, await forgedRes.json());
