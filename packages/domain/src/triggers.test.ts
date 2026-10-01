import { describe, expect, test } from "bun:test";
import {
  afterFire,
  canFire,
  cronProblem,
  expire,
  isDue,
  nextFireAt,
  type TriggerLifecycle,
} from "./triggers.ts";

const zone = "America/New_York";
const at = (iso: string) => new Date(iso);

const trigger = (
  overrides: Partial<TriggerLifecycle> = {},
): TriggerLifecycle => ({
  kind: "subscription",
  status: "active",
  at: null,
  cron: null,
  maxFires: null,
  fireCount: 0,
  expiresAt: null,
  onExpireNote: null,
  nextFireAt: null,
  ...overrides,
});

describe("trigger lifecycle", () => {
  test("cron's next occurrence is in the user's zone, once a day across both DST changes", () => {
    const cases: [string, string, string[]][] = [
      // Spring forward (2027-03-14): 2:30 doesn't exist and runs at 3:30 that day.
      [
        "30 2 * * *",
        "2027-03-13T12:00:00Z",
        ["2027-03-14T07:30:00.000Z", "2027-03-15T06:30:00.000Z"],
      ],
      // Fall back (2026-11-01): 1:30 happens twice and runs once, at the first.
      [
        "30 1 * * *",
        "2026-10-31T12:00:00Z",
        ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
      ],
      // Weekdays at 8: from a Friday morning, Monday.
      ["0 8 * * 1-5", "2026-10-02T13:00:00Z", ["2026-10-05T12:00:00.000Z"]],
    ];
    for (const [cron, from, expected] of cases) {
      let after = at(from);
      for (const expectedNext of expected) {
        const next = nextFireAt(
          { kind: "schedule", at: null, cron },
          after,
          zone,
        );
        expect(next?.toISOString()).toBe(expectedNext);
        if (!next) break;
        after = next;
      }
    }
  });

  test("a one-off fires at its time once; subscriptions have no schedule", () => {
    const once = {
      kind: "schedule" as const,
      at: at("2026-10-02T18:45:00Z"),
      cron: null,
    };
    expect(nextFireAt(once, at("2026-10-02T12:00:00Z"), zone)).toEqual(once.at);
    expect(nextFireAt(once, at("2026-10-02T18:45:00Z"), zone)).toBeNull();
    expect(
      nextFireAt(
        { kind: "subscription", at: null, cron: null },
        new Date(),
        zone,
      ),
    ).toBeNull();
  });

  test("firing counts up, and max_fires (or a spent one-off) exhausts it", () => {
    const fired = at("2026-10-02T12:00:00Z");
    const rows: [
      string,
      Partial<TriggerLifecycle>,
      ReturnType<typeof afterFire>,
    ][] = [
      [
        "one-shot subscription",
        { maxFires: 1 },
        { fireCount: 1, status: "exhausted", nextFireAt: null },
      ],
      [
        "standing subscription",
        {},
        { fireCount: 1, status: "active", nextFireAt: null },
      ],
      [
        "daily schedule",
        { kind: "schedule", cron: "0 8 * * *", fireCount: 4 },
        {
          fireCount: 5,
          status: "active",
          nextFireAt: at("2026-10-03T12:00:00Z"),
        },
      ],
      [
        "daily schedule at its last fire",
        { kind: "schedule", cron: "0 8 * * *", maxFires: 5, fireCount: 4 },
        { fireCount: 5, status: "exhausted", nextFireAt: null },
      ],
      [
        "one-off schedule",
        { kind: "schedule", at: fired, maxFires: 1 },
        { fireCount: 1, status: "exhausted", nextFireAt: null },
      ],
    ];
    for (const [, state, expected] of rows)
      expect(afterFire(trigger(state), fired, zone)).toEqual(expected);
  });

  test("expiry: the trigger expires, and its on_expire run is due only if it hadn't used its fires", () => {
    const now = at("2026-10-09T13:00:00Z");
    const due = {
      expiresAt: at("2026-10-09T13:00:00Z"),
      onExpireNote: "Sam never replied.",
    };
    const rows: [
      string,
      Partial<TriggerLifecycle>,
      ReturnType<typeof expire>,
    ][] = [
      [
        "never fired, with a note",
        { ...due, maxFires: 1 },
        { status: "expired", runOnExpire: true },
      ],
      [
        "fired already",
        { ...due, maxFires: 1, fireCount: 1 },
        { status: "expired", runOnExpire: false },
      ],
      ["unlimited, with a note", due, { status: "expired", runOnExpire: true }],
      [
        "no note",
        { expiresAt: due.expiresAt, maxFires: 1 },
        { status: "expired", runOnExpire: false },
      ],
      ["not yet", { ...due, expiresAt: at("2026-10-09T13:00:01Z") }, undefined],
      ["deleted", { ...due, status: "deleted" }, undefined],
    ];
    for (const [, state, expected] of rows)
      expect(expire(trigger(state), now)).toEqual(expected);
  });

  test("due and can-fire: active, in time, under max_fires, and never once deleted or expired", () => {
    const now = at("2026-10-02T12:00:00Z");
    const schedule = {
      kind: "schedule" as const,
      cron: "0 8 * * *",
      nextFireAt: at("2026-10-02T11:59:00Z"),
    };
    expect(isDue(trigger(schedule), now)).toBe(true);
    expect(
      isDue(
        trigger({ ...schedule, nextFireAt: at("2026-10-02T12:01:00Z") }),
        now,
      ),
    ).toBe(false);
    expect(
      isDue(
        trigger({ ...schedule, expiresAt: at("2026-10-02T11:00:00Z") }),
        now,
      ),
    ).toBe(false);
    expect(isDue(trigger({ ...schedule, status: "deleted" }), now)).toBe(false);
    expect(canFire(trigger({ maxFires: 2, fireCount: 1 }), now)).toBe(true);
    expect(canFire(trigger({ maxFires: 2, fireCount: 2 }), now)).toBe(false);
    expect(canFire(trigger({ expiresAt: now }), now)).toBe(false);
    expect(canFire(trigger({ status: "exhausted" }), now)).toBe(false);
  });

  test("cron patterns must have five valid fields", () => {
    expect(cronProblem("0 8 * * 1-5")).toBeUndefined();
    expect(cronProblem("0 0 8 * * 1-5")).toContain("has 6 fields");
    expect(cronProblem("0 25 * * *")).toContain("isn't a valid cron pattern");
  });
});
