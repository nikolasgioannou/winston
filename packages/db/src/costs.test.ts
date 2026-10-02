import { describe, expect, test } from "bun:test";
import { costReport, formatCostReport, monthRange } from "./costs.ts";
import { costLedger } from "./schema/index.ts";
import { inRollback, insertRun, insertUser, testDb } from "./testing.ts";

const db = await testDb();

describe("the cost report", () => {
  test("groups spend by category, agent kind and trigger, with the top runs, for one user and month", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      const front = await insertRun(tx, user.id, { kind: "front" });
      const delegated = await insertRun(tx, user.id, {
        kind: "background",
        triggerType: "delegate",
        brief: "Book a table\nfor two",
      });
      const event = await insertRun(tx, user.id, {
        kind: "background",
        triggerType: "event",
        brief: "A reply came",
      });
      const at = new Date("2026-10-05T12:00:00Z");
      const row = (
        userId: string,
        runId: string | null,
        category: "model" | "jev" | "vm" | "stt",
        costUsd: string,
        occurredAt = at,
      ) => ({ userId, runId, category, costUsd, occurredAt });
      await tx.insert(costLedger).values([
        row(user.id, front.id, "model", "0.100000"),
        row(user.id, delegated.id, "model", "0.400000"),
        row(user.id, delegated.id, "jev", "0.000400"),
        row(user.id, event.id, "model", "0.050000"),
        row(user.id, null, "vm", "1.250000"),
        // Another month, and another user: neither counts.
        row(
          user.id,
          front.id,
          "model",
          "9.000000",
          new Date("2026-09-30T23:59:00Z"),
        ),
        row(other.id, null, "vm", "5.000000"),
      ]);
      const report = await costReport(tx, {
        userId: user.id,
        ...monthRange("2026-10"),
      });
      expect(report.total).toBeCloseTo(1.8004, 6);
      expect(report.byCategory).toEqual([
        { category: "vm", usd: 1.25 },
        { category: "model", usd: 0.55 },
        { category: "jev", usd: 0.0004 },
      ]);
      expect(report.modelByKind).toEqual([
        { kind: "background", usd: 0.45 },
        { kind: "front", usd: 0.1 },
      ]);
      expect(report.modelByTrigger).toEqual([
        { trigger: "delegate", usd: 0.4 },
        { trigger: "user", usd: 0.1 },
        { trigger: "event", usd: 0.05 },
      ]);
      expect(report.topRuns.map((r) => [r.runId, r.usd])).toEqual([
        [delegated.id, 0.4004],
        [front.id, 0.1],
        [event.id, 0.05],
      ]);
      const text = formatCostReport(report, "someone@example.com");
      expect(text).toContain("Spend for someone@example.com, 2026-10: $1.80");
      expect(text).toContain("Book a table");
      expect(text).toContain("(a front-of-house turn)");

      // Everyone: both users.
      const all = await costReport(tx, monthRange("2026-10"));
      expect(all.total).toBeCloseTo(6.8004, 6);
    });
  });

  test("a month is its UTC calendar month; nonsense is refused", () => {
    expect(monthRange("2026-12")).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    expect(() => monthRange("Oct")).toThrow();
  });
});
