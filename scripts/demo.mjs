import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";

config();

const prisma = new PrismaClient();
const port = process.env.PORT ?? 3000;

const plan = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
const tenant = await prisma.tenant.create({
  data: {
    name: "Demo Tenant",
    email: `demo-${Date.now()}@example.com`,
    planId: plan.id,
  },
});

console.log(`Created tenant ${tenant.id} on the Free plan (api_call limit ${plan.apiCallLimit}).\n`);
console.log("Try these against a running `npm run dev` server:\n");

console.log(`curl -X POST localhost:${port}/usage -H "Content-Type: application/json" -d '{"tenant_id":"${tenant.id}","event_type":"api_call","quantity":10,"idempotency_key":"demo-1"}'`);
console.log(`curl -X POST localhost:${port}/usage -H "Content-Type: application/json" -d '{"tenant_id":"${tenant.id}","event_type":"api_call","quantity":10,"idempotency_key":"demo-1"}'   # same key -> replay, no double count`);
console.log(`curl -X POST localhost:${port}/usage -H "Content-Type: application/json" -d '{"tenant_id":"${tenant.id}","event_type":"api_call","quantity":5000,"idempotency_key":"demo-2"}'  # over quota -> 402`);
console.log(`curl "localhost:${port}/usage?tenant_id=${tenant.id}"`);

await prisma.$disconnect();
