import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";
import { ago } from "./task.ts";

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "running",
  trigger: "delegate",
  stepCount: 8,
  effort: "high",
  createdAt: minutesAgo(12),
  finishedAt: null,
  cancelRequested: false,
  waitingFor: null,
  brief: "Compare the three lease offers in Nik's mail.\nReport the cheapest.",
  result: null,
  ...overrides,
});

describe("winston task", () => {
  test("list: one line each with status, age, steps and the brief's first line", async () => {
    const { out, requests } = await cli(["task", "list"], () =>
      Response.json({
        timeZone: "America/New_York",
        tasks: [
          task("task_01a"),
          task("task_01b", {
            status: "parked",
            stepCount: 1,
            createdAt: minutesAgo(180),
          }),
          task("task_01c", {
            cancelRequested: true,
            createdAt: minutesAgo(0.5),
          }),
        ],
        cursor: null,
      }),
    );
    expect(new URL(requests[0]?.url ?? "").search).toBe("");
    expect(out).toBe(
      [
        "task_01a  running  12m ago  8 steps  Compare the three lease offers in Nik's mail.",
        "task_01b  parked  3h ago  1 step  Compare the three lease offers in Nik's mail.",
        "task_01c  cancelling  30s ago  8 steps  Compare the three lease offers in Nik's mail.",
      ].join("\n"),
    );
    const empty = await cli(["task", "list"], () =>
      Response.json({ timeZone: "UTC", tasks: [], cursor: null }),
    );
    expect(empty.out).toBe("No tasks running or parked.");
  });

  test("get shows the brief and result in full", async () => {
    const { out } = await cli(["task", "get", "task_01a"], () =>
      Response.json({
        timeZone: "America/New_York",
        task: task("task_01a", {
          status: "completed",
          createdAt: "2026-10-01T14:15:00.000Z",
          finishedAt: "2026-10-01T14:31:00.000Z",
          result: "Northside is cheapest at $2,350/month.",
        }),
      }),
    );
    expect(out).toBe(
      [
        "task_01a · completed · 8 steps · effort high",
        "Started: 2026-10-01 10:15 -04:00 (delegated by the front of house)",
        "Finished: 2026-10-01 10:31 -04:00",
        "Brief:",
        "  Compare the three lease offers in Nik's mail.",
        "  Report the cheapest.",
        "Result:",
        "  Northside is cheapest at $2,350/month.",
      ].join("\n"),
    );
  });

  test("cancel says what happens; resuming a task that isn't parked exits 6", async () => {
    const cancelling = await cli(["task", "cancel", "task_01a"], () =>
      Response.json({
        id: "task_01a",
        outcome: "cancelling",
        status: "running",
      }),
    );
    expect(cancelling.requests[0]?.method).toBe("POST");
    expect(cancelling.out).toBe(
      "Cancelling task_01a: it stops at its next step, and its report of what it had done comes back to you.",
    );
    const resumed = await cli(
      ["task", "resume", "task_01b", "--note", "user says done"],
      () => Response.json({ id: "task_01b", status: "running" }),
    );
    expect(await resumed.requests[0]?.clone().json()).toEqual({
      note: "user says done",
    });
    expect(resumed.out).toBe("Resumed task_01b.");
    const conflict = await cli(["task", "resume", "task_01a"], () =>
      Response.json(
        {
          error: {
            code: "conflict",
            message:
              "task_01a isn't parked (it's running), so there's nothing to resume.",
            hint: null,
          },
        },
        { status: 409 },
      ),
    );
    expect(conflict.code).toBe(6);
    expect(conflict.err).toContain("isn't parked");
  });

  test("ages", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(
      [
        "2026-10-01T11:59:15Z",
        "2026-10-01T11:48:00Z",
        "2026-10-01T09:00:00Z",
        "2026-09-29T12:00:00Z",
      ].map((at) => ago(at, now)),
    ).toEqual(["45s", "12m", "3h", "2d"]);
  });

  test("update changes the current task's effort unless given an id; bad levels never reach the backend", async () => {
    const current = await cli(["task", "update", "--effort", "high"], () =>
      Response.json({
        timeZone: "UTC",
        task: task("task_01a", { effort: "high" }),
      }),
    );
    expect(current.requests[0]?.method).toBe("PATCH");
    expect(new URL(current.requests[0]?.url ?? "").pathname).toBe(
      "/v1/tasks/current",
    );
    expect(current.out).toBe(
      "task_01a now runs at high effort, from its next step.",
    );
    const named = await cli(
      ["task", "update", "task_01b", "--effort", "low"],
      () =>
        Response.json({
          timeZone: "UTC",
          task: task("task_01b", { effort: "low" }),
        }),
    );
    expect(new URL(named.requests[0]?.url ?? "").pathname).toBe(
      "/v1/tasks/task_01b",
    );
    for (const argv of [
      ["task", "update", "--effort", "max"],
      ["task", "update"],
    ]) {
      const bad = await cli(argv, () => Response.json({}));
      expect(bad.code).toBe(1);
      expect(bad.requests).toHaveLength(0);
    }
  });
});
