import assert from "node:assert/strict";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { validateDatabaseEnvironment } from "@winston/adapters/database";
import { validateRuntimeEnvironment } from "../src/environment";

const local = {
  DATABASE_URL: "postgres://developer:synthetic-secret@127.0.0.1:5432/winston_dev",
  DIRECT_DATABASE_URL: "postgresql://developer:synthetic-secret@localhost:5432/winston_dev",
  BETTER_AUTH_URL: "http://127.0.0.1:3001",
  WEB_ORIGIN: "http://127.0.0.1:5173",
  GOOGLE_CLIENT_ID: "local-sign-in",
  GOOGLE_CONNECTOR_CLIENT_ID: "local-connections",
};

test("local startup rejects remote or mixed targets without echoing credentials", () => {
  for (const mode of [undefined, "development", "test"]) {
    assert.doesNotThrow(() => {
      validateRuntimeEnvironment({ ...local, NODE_ENV: mode });
    });
    for (const field of ["DATABASE_URL", "DIRECT_DATABASE_URL"]) {
      for (const url of [
        "postgres://developer:synthetic-secret@production.example/winston",
        "postgres://developer:synthetic-secret@127.0.0.1.evil.example/winston_dev",
        "postgres://developer:synthetic-secret@127.0.0.1/winston_dev?host=production.example",
        "postgres://developer:synthetic-secret@127.0.0.1/winston_dev?hostaddr=192.0.2.1",
        "postgres://developer:synthetic-secret@127.0.0.1/winston_dev?service=production",
        "postgres://developer:synthetic-secret@127.0.0.1/winston_dev?HOST=production.example",
        "https://developer:synthetic-secret@127.0.0.1/winston_dev",
        "postgres://127.0.0.1/winston_dev",
        "postgres://developer:synthetic-secret@127.0.0.1/",
        "not a URL synthetic-secret",
      ]) {
        assert.throws(
          () => {
            validateRuntimeEnvironment({ ...local, NODE_ENV: mode, [field]: url });
          },
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(field));
            assert.doesNotMatch(error.message, /synthetic-secret|production\.example/);
            return true;
          },
        );
      }
    }
  }
  assert.throws(() => {
    validateRuntimeEnvironment({
      ...local,
      DIRECT_DATABASE_URL: "postgres://developer@localhost/another_database",
    });
  }, /same local database/);
  assert.throws(() => {
    validateRuntimeEnvironment({
      ...local,
      DIRECT_DATABASE_URL: "postgres://developer@localhost:6432/winston_dev",
    });
  }, /same local database and port/);
  for (const field of ["BETTER_AUTH_URL", "WEB_ORIGIN"]) {
    assert.throws(() => {
      validateRuntimeEnvironment({ ...local, [field]: "https://production.example" });
    }, /loopback HTTP origin/);
  }
  assert.throws(() => {
    validateRuntimeEnvironment({ ...local, NODE_ENV: "prod" });
  }, /NODE_ENV/);
  assert.throws(() => {
    validateRuntimeEnvironment({ ...local, FLY_MACHINE_ID: "abcdef123456" });
  }, /Fly services/);
  assert.throws(() => {
    validateRuntimeEnvironment({ ...local, GOOGLE_CONNECTOR_CLIENT_ID: local.GOOGLE_CLIENT_ID });
  }, /separate OAuth clients/);
});

test("production explicitly accepts managed database targets and public HTTPS origins", () => {
  const production = {
    ...local,
    NODE_ENV: "production",
    FLY_MACHINE_ID: "abcdef123456",
    DATABASE_URL: "postgres://app:synthetic-secret@pool.example/app?sslmode=require",
    DIRECT_DATABASE_URL: "postgres://app:synthetic-secret@direct.example/app?sslmode=require",
    BETTER_AUTH_URL: "https://winston.example",
    WEB_ORIGIN: "https://winston.example",
  };
  assert.doesNotThrow(() => {
    validateRuntimeEnvironment(production);
  });
  for (const field of ["BETTER_AUTH_URL", "WEB_ORIGIN"]) {
    assert.throws(() => {
      validateRuntimeEnvironment({ ...production, [field]: local.WEB_ORIGIN });
    }, /public HTTPS origin/);
  }
  assert.doesNotThrow(() => {
    validateDatabaseEnvironment(
      { DIRECT_DATABASE_URL: "postgres://developer@[::1]:5432/winston_dev?sslmode=disable" },
      ["DIRECT_DATABASE_URL"],
    );
  });
  assert.throws(() => {
    validateDatabaseEnvironment({ DIRECT_DATABASE_URL: production.DIRECT_DATABASE_URL }, [
      "DIRECT_DATABASE_URL",
    ]);
  }, /loopback PostgreSQL/);
  assert.throws(() => {
    validateDatabaseEnvironment({}, ["DIRECT_DATABASE_URL"]);
  }, /DIRECT_DATABASE_URL/);
});

test("runtime entrypoints reject remote local databases before startup", async () => {
  for (const entrypoint of [
    "apps/server/src/main.ts",
    "apps/server/src/telegram-poll.ts",
    "packages/adapters/src/database/migrate.ts",
  ]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", entrypoint], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: {
        NODE_ENV: "development",
        DATABASE_URL: "postgres://developer:synthetic-secret@production.invalid/app",
        DIRECT_DATABASE_URL: "postgres://developer:synthetic-secret@production.invalid/app",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => {
      child.kill();
    }, 5000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.notEqual(code, 0, entrypoint);
      assert.match(stderr, /loopback PostgreSQL/, entrypoint);
      assert.doesNotMatch(stdout + stderr, /synthetic-secret|production\.invalid/, entrypoint);
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  }
});
