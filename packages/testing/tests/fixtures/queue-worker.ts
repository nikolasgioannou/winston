import assert from "node:assert/strict";
import { PgBoss } from "pg-boss";

const connectionString = process.env.TEST_DATABASE_URL;
assert.ok(connectionString);
assert.equal(new URL(connectionString).hostname, "127.0.0.1");

const boss = new PgBoss({ connectionString, supervise: false, schedule: false });

boss.on("error", () => {
  process.exitCode = 1;
});

await boss.start();
await boss.work("crash", { pollingIntervalSeconds: 0.5 }, async ([job]) => {
  assert.ok(job);

  console.log("claimed");

  // Keep the process alive until the parent kills it, without completing the job.
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
});
