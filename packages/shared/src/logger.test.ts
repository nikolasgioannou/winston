import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger.ts";

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
        connection: { ciphertext: "xyz", alias: "work" },
      },
      "request",
    );
    const line = JSON.stringify(lines[0]);
    for (const secret of ["t0p", "Bearer abc", "xyz"])
      expect(line).not.toContain(secret);
    expect(lines[0]).toMatchObject({
      token: "[redacted]",
      headers: { authorization: "[redacted]", accept: "json" },
      connection: { ciphertext: "[redacted]", alias: "work" },
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
