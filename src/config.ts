import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: requireEnv("DATABASE_URL"),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_placeholder",
  checkoutSuccessUrl:
    process.env.CHECKOUT_SUCCESS_URL ?? "http://localhost:3000/checkout/success",
  checkoutCancelUrl:
    process.env.CHECKOUT_CANCEL_URL ?? "http://localhost:3000/checkout/cancel",
};
