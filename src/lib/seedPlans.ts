import type { PrismaClient } from "@prisma/client";

export const FREE_PLAN = {
  name: "Free",
  apiCallLimit: 1000,
  aiTokenLimit: 100000,
  priceCents: 0,
  stripePriceId: null as string | null,
};

export const PRO_PLAN = {
  name: "Pro",
  apiCallLimit: 100000,
  aiTokenLimit: 10000000,
  priceCents: 4900,
  // Real Stripe TEST-mode price (product prod_UuNHla3NDjiDMb), created via
  // `stripe prices create` for local Checkout testing.
  stripePriceId: "price_1TuYWeJMT8l47PlWk7S3snDa",
};

export async function seedPlans(prisma: PrismaClient) {
  const free = await prisma.plan.upsert({
    where: { name: FREE_PLAN.name },
    update: FREE_PLAN,
    create: FREE_PLAN,
  });
  const pro = await prisma.plan.upsert({
    where: { name: PRO_PLAN.name },
    update: PRO_PLAN,
    create: PRO_PLAN,
  });
  return { free, pro };
}
