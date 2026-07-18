import type { Prisma, PrismaClient } from "@prisma/client";

export interface Period {
  start: Date;
  end: Date;
}

export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Current billing period for quota/rollup purposes.
 *
 * If the tenant has a subscription row, its current_period_start/end (kept
 * in sync from Stripe via webhooks) is authoritative. Tenants without a
 * subscription (e.g. still on the Free plan, never checked out) fall back
 * to the current calendar month.
 */
export async function getCurrentPeriod(tx: DbClient, tenantId: string): Promise<Period> {
  const subscription = await tx.subscription.findFirst({
    where: { tenantId },
    orderBy: { currentPeriodStart: "desc" },
  });

  if (subscription) {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
