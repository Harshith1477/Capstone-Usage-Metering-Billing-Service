import express from "express";
import { webhooksRouter } from "./routes/webhooks.js";
import { usageRouter } from "./routes/usage.js";
import { checkoutRouter } from "./routes/checkout.js";

export function createApp() {
  const app = express();

  // Mounted first, and with its own express.raw() middleware, so the raw
  // body is available for Stripe signature verification. Must come before
  // the global express.json() below or the body would already be parsed.
  app.use(webhooksRouter);

  app.use(express.json());
  app.use(usageRouter);
  app.use(checkoutRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}
