import { config as loadEnv } from "dotenv";
import { beforeAll, beforeEach, afterAll } from "vitest";

loadEnv();

// Route the app's Prisma client at the dedicated test database instead of
// the dev one. Must happen before src/db.ts is imported anywhere.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { prisma } = await import("../src/db.js");
const { seedPlans } = await import("../src/lib/seedPlans.js");

beforeAll(async () => {
  await seedPlans(prisma);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE usage_events, webhook_events, subscriptions, tenants RESTART IDENTITY CASCADE`
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
