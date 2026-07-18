import { randomUUID } from "node:crypto";
import { prisma } from "../src/db.js";

export async function createTenant(planName: "Free" | "Pro" = "Free") {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { name: planName } });
  return prisma.tenant.create({
    data: {
      name: `Test Tenant ${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      planId: plan.id,
    },
  });
}
