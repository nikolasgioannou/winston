import { describe, expect, test } from "bun:test";
import { createLogger, logConfigSchema } from "./logger.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { lines, destination };
}

describe("createLogger", () => {
  test("writes JSON lines tagged with the service", () => {
    const { lines, destination } = capture();
    createLogger("agents", { pretty: false, destination }).info(
      { jobId: "j1" },
      "leased",
    );
    expect(lines[0]).toMatchObject({
      service: "agents",
      jobId: "j1",
      msg: "leased",
      level: 30,
    });
    expect(typeof lines[0]?.time).toBe("string");
  });

  test("child loggers carry their context on every line", () => {
    const { lines, destination } = capture();
    const run = createLogger("agents", { pretty: false, destination }).child({
      userId: "usr_1",
      runId: "run_1",
    });
    run.info("step");
    run.child({ jobId: "job_1" }).warn("retrying");
    expect(lines[0]).toMatchObject({
      userId: "usr_1",
      runId: "run_1",
      msg: "step",
    });
    expect(lines[1]).toMatchObject({
      userId: "usr_1",
      runId: "run_1",
      jobId: "job_1",
      msg: "retrying",
    });
  });

  test("redacts sensitive values at the top level and one level down", () => {
    const { lines, destination } = capture();
    createLogger("api", { pretty: false, destination }).info(
      {
        token: "t0p",
        headers: { authorization: "Bearer abc", accept: "json" },
        connection: { ciphertext: "xyz", email: "ada@acme.com" },
      },
      "request",
    );
    const line = JSON.stringify(lines[0]);
    for (const secret of ["t0p", "Bearer abc", "xyz"])
      expect(line).not.toContain(secret);
    expect(lines[0]).toMatchObject({
      token: "[redacted]",
      headers: { authorization: "[redacted]", accept: "json" },
      connection: { ciphertext: "[redacted]", email: "ada@acme.com" },
    });
  });

  test("respects the level", () => {
    const { lines, destination } = capture();
    const logger = createLogger("api", {
      pretty: false,
      level: "warn",
      destination,
    });
    logger.info("hidden");
    logger.warn("shown");
    expect(lines.map((line) => line.msg)).toEqual(["shown"]);
  });
});

describe("logConfigSchema", () => {
  test("defaults to info, with pretty output left to the terminal check", () => {
    expect(logConfigSchema.parse({})).toEqual({ LOG_LEVEL: "info" });
  });

  test("parses LOG_PRETTY from an env string", () => {
    expect(logConfigSchema.parse({ LOG_PRETTY: "true" }).LOG_PRETTY).toBe(true);
    expect(logConfigSchema.parse({ LOG_PRETTY: "false" }).LOG_PRETTY).toBe(
      false,
    );
    expect(logConfigSchema.safeParse({ LOG_PRETTY: "maybe" }).success).toBe(
      false,
    );
  });
});
