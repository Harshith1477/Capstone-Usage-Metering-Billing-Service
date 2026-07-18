import { config } from "dotenv";
import { spawnSync } from "node:child_process";

config();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.error("TEST_DATABASE_URL not set — check .env (see .env.example)");
  process.exit(1);
}

const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl },
});

process.exit(push.status ?? 1);
