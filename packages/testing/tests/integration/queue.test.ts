import assert from "node:assert/strict";
import { test } from "bun:test";
import { Client, DatabaseError } from "pg";
import { PgBoss } from "pg-boss";
import { withTestPostgres } from "../../src/postgres";

async function jobState(boss: PgBoss, queue: string, id: string) {
  const jobs = await boss.findJobs(queue, { id });

  return jobs[0]?.state;
}

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = performance.now() + 15_000;

  while (performance.now() < deadline) {
    if (await check()) {
      return;
    }

    await Bun.sleep(25);
  }

  assert.fail(`Timed out waiting for ${description}`);
}

test("domain, outbox, and job writes commit or roll back together", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
    const client = new Client({ connectionString });
    const errors: unknown[] = [];

    boss.on("error", (error) => {
      errors.push(error);
    });

    try {
      await boss.start();
      await boss.createQueue("outbox");
      await client.connect();
      await sql`CREATE TABLE synthetic_tasks (id integer PRIMARY KEY)`;
      await sql`CREATE TABLE synthetic_outbox (task_id integer REFERENCES synthetic_tasks(id))`;

      const db = {
        executeSql: (text: string, values?: unknown[]) => client.query(text, values),
      };

      await client.query("BEGIN");
      await client.query("INSERT INTO synthetic_tasks VALUES (1)");
      await client.query("INSERT INTO synthetic_outbox VALUES (1)");
      const rolledBack = await boss.send("outbox", { task: 1 }, { db });
      assert.ok(rolledBack);

      assert.deepEqual(await boss.fetch("outbox"), []);
      await client.query("ROLLBACK");

      assert.equal(await jobState(boss, "outbox", rolledBack), undefined);
      assert.equal((await sql<{ id: number }[]>`SELECT * FROM synthetic_tasks`).length, 0);
      assert.equal((await sql<{ task_id: number }[]>`SELECT * FROM synthetic_outbox`).length, 0);

      await client.query("BEGIN");
      await client.query("INSERT INTO synthetic_tasks VALUES (2)");
      await client.query("INSERT INTO synthetic_outbox VALUES (2)");
      const committed = await boss.send("outbox", { task: 2 }, { db });
      await client.query("COMMIT");

      const jobs = await boss.fetch<{ task: number }>("outbox");
      assert.equal(jobs[0]?.id, committed);
      assert.equal(jobs[0].data.task, 2);
      assert.equal((await sql<{ task_id: number }[]>`SELECT * FROM synthetic_outbox`).length, 1);
      assert.deepEqual(errors, []);
    } finally {
      await client.end();
      await boss.stop();
    }
  });
});

test("retry, cancellation, delayed delivery, and schedule persistence work under Bun", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
    const errors: unknown[] = [];

    boss.on("error", (error) => {
      errors.push(error);
    });

    try {
      await boss.start();
      await boss.createQueue("retry", { retryLimit: 1, retryDelay: 0 });
      await boss.createQueue("later");

      const retryId = await boss.send("retry", { operation: "synthetic" });
      assert.ok(retryId);
      let attempts = 0;

      await boss.work("retry", { pollingIntervalSeconds: 0.5 }, async () => {
        await Promise.resolve();
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Injected transient failure");
        }
      });

      await until(
        async () => (await jobState(boss, "retry", retryId)) === "completed",
        "retry completion",
      );
      assert.equal(attempts, 2);

      const canceled = await boss.send("later", {});
      assert.ok(canceled);
      await boss.cancel("later", canceled);
      assert.deepEqual(await boss.fetch("later"), []);
      assert.equal(await jobState(boss, "later", canceled), "cancelled");

      const delayed = await boss.send("later", {}, { startAfter: new Date(Date.now() + 1000) });
      assert.ok(delayed);
      assert.deepEqual(await boss.fetch("later"), []);

      await until(async () => {
        const jobs = await boss.fetch("later");

        return jobs.some((job) => job.id === delayed);
      }, "delayed job eligibility");

      await boss.schedule("later", "0 9 * * *", {}, { tz: "America/Los_Angeles" });
      await boss.stop();
      await boss.start();

      const schedules = await boss.getSchedules();
      assert.ok(
        schedules.some(
          (schedule) => schedule.name === "later" && schedule.timezone === "America/Los_Angeles",
        ),
      );
      await boss.unschedule("later");
      assert.deepEqual(await boss.getSchedules(), []);
      assert.deepEqual(errors, []);
    } finally {
      await boss.stop();
    }
  });
});

test("a killed Bun worker leaves a recoverable claim and does not lose queued jobs", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    const boss = new PgBoss({
      connectionString,
      supervise: false,
      schedule: false,
      monitorIntervalSeconds: 1,
    });
    const errors: unknown[] = [];

    boss.on("error", (error) => {
      errors.push(error);
    });

    let worker: ReturnType<typeof Bun.spawn> | undefined;

    try {
      await boss.start();
      await boss.createQueue("crash", { expireInSeconds: 2, retryLimit: 1, retryDelay: 0 });
      const first = await boss.send("crash", { position: 1 });
      const second = await boss.send("crash", { position: 2 });
      assert.ok(first);
      assert.ok(second);

      worker = Bun.spawn(
        [process.execPath, new URL("../fixtures/queue-worker.ts", import.meta.url).pathname],
        {
          env: { TEST_DATABASE_URL: connectionString },
          stdout: "ignore",
          stderr: "ignore",
        },
      );

      await until(async () => (await jobState(boss, "crash", first)) === "active", "child claim");
      worker.kill("SIGKILL");
      await worker.exited;

      await until(async () => {
        await boss.supervise("crash");

        return (await jobState(boss, "crash", first)) === "retry";
      }, "expired claim recovery");

      const recovered: string[] = [];
      await boss.work("crash", { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        await Promise.resolve();
        recovered.push(...jobs.map((job) => job.id));
      });

      await until(
        async () =>
          (await jobState(boss, "crash", second)) === "completed" &&
          (await jobState(boss, "crash", first)) === "completed",
        "restarted worker completion",
      );

      assert.deepEqual(recovered.sort(), [first, second].sort());
      assert.deepEqual(errors, []);
    } finally {
      worker?.kill();
      await worker?.exited;
      await boss.stop();
    }
  });
});

test("LISTEN reconnects after session loss and pending work remains discoverable", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const boss = new PgBoss({
      connectionString,
      application_name: "winston_notify_test",
      useListenNotify: true,
      supervise: false,
      schedule: false,
    });
    const errors: unknown[] = [];

    boss.on("error", (error) => {
      errors.push(error);
    });

    try {
      await boss.start();
      await boss.createQueue("notify", { notify: true });
      const received: string[] = [];

      await boss.work(
        "notify",
        { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 30 },
        async (jobs) => {
          await Promise.resolve();
          received.push(...jobs.map((job) => job.id));
        },
      );

      const listeners = await sql<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE application_name = 'winston_notify_test' AND query LIKE 'LISTEN %'
      `;
      const listener = listeners[0];
      assert.ok(listener);

      await sql`SELECT pg_terminate_backend(${listener.pid})`;
      const id = await boss.send("notify", {});
      assert.ok(id);

      await until(async () => {
        const reconnected = await sql<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE application_name = 'winston_notify_test' AND pid <> ${listener.pid} AND query LIKE 'LISTEN %'
        `;

        return reconnected.length > 0;
      }, "LISTEN resubscription");

      await until(
        async () => (await jobState(boss, "notify", id)) === "completed",
        "work after listener loss",
      );
      assert.deepEqual(received, [id]);
      assert.equal(errors.length, 1);
      assert.ok(errors[0] instanceof DatabaseError);
      assert.equal(errors[0].code, "57P01");
    } finally {
      await boss.stop();
    }
  });
});
