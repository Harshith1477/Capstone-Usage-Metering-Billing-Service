import { PrismaClient } from "@prisma/client";
import { seedPlans } from "../src/lib/seedPlans.js";

const prisma = new PrismaClient();

async function main() {
  await seedPlans(prisma);
  console.log("Seeded plans: Free, Pro");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
