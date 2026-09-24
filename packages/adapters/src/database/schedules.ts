import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  scheduleSchema,
  scheduleRequestSchema,
  type Schedule,
  type ScheduleRequest,
} from "@winston/contracts/schedules";
import { nextScheduleOccurrence, recoverScheduleOccurrence } from "../schedules";
import type { DatabaseTransaction } from "./owners";
import { taskRepository } from "./tasks";

export class ScheduleWriteError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid_request") {
    super(
      kind === "not_found"
        ? "Schedule is unavailable."
        : kind === "conflict"
          ? "Schedule revision is stale or its creation key conflicts."
          : "Schedule has no occurrences.",
    );
  }
}

export function scheduleRepository(transaction: DatabaseTransaction, ownerId: string) {
  const tasks = taskRepository(transaction, ownerId);
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function find(id: string) {
    scheduleSchema.shape.id.parse(id);
    const result = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.schedules WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    return result.rows[0] ? scheduleSchema.parse(result.rows[0].document) : undefined;
  }
  async function save(schedule: Schedule) {
    const parsed = scheduleSchema.parse(schedule);
    await transaction.execute(sql`
      UPDATE winston.schedules SET document = ${JSON.stringify(parsed)}::jsonb,
        next_run_at = ${parsed.nextRunAt}::timestamptz
      WHERE owner_id = ${ownerId}::uuid AND id = ${parsed.id}::uuid
    `);
    return parsed;
  }
  async function validate(input: ScheduleRequest) {
    const request = scheduleRequestSchema.parse(input);
    request.sourceMessageIds = [...new Set(request.sourceMessageIds)].sort();
    const sources = await transaction.execute(sql`
      SELECT id FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid
        AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(request.sourceMessageIds)}::jsonb)::uuid)
    `);
    if (sources.rowCount !== request.sourceMessageIds.length)
      throw new Error("Schedule source messages are unavailable to this owner.");
    const nextRunAt = nextScheduleOccurrence(request.timing, request.timing.startAt, true);
    if (!nextRunAt) throw new ScheduleWriteError("invalid_request");
    return { request, nextRunAt };
  }
  async function current(id: string, revision: number) {
    await lock();
    const schedule = await find(id);
    if (!schedule) throw new ScheduleWriteError("not_found");
    if (schedule.revision !== revision) throw new ScheduleWriteError("conflict");
    return schedule;
  }
  async function cancelOutstanding(id: string) {
    const result = await transaction.execute<{ taskId: string }>(sql`
      SELECT o.task_id AS "taskId" FROM winston.schedule_occurrences o
      JOIN winston.tasks t ON t.owner_id = o.owner_id AND t.id = o.task_id
      WHERE o.owner_id = ${ownerId}::uuid AND o.schedule_id = ${id}::uuid
        AND t.document->>'state' IN ('queued', 'running', 'waiting')
    `);
    for (const row of result.rows) {
      const task = await tasks.find(row.taskId);
      if (task) await tasks.cancel(task.id, task.revision);
    }
  }
  return {
    find,
    async findByKey(key: string) {
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.schedules WHERE owner_id = ${ownerId}::uuid AND request_key = ${key}
      `);
      return result.rows[0] ? scheduleSchema.parse(result.rows[0].document) : undefined;
    },
    async list(afterId?: string) {
      if (afterId) scheduleSchema.shape.id.parse(afterId);
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.schedules WHERE owner_id = ${ownerId}::uuid
          ${afterId ? sql`AND id > ${afterId}::uuid` : sql``} ORDER BY id LIMIT 100
      `);
      return result.rows.map((row) => scheduleSchema.parse(row.document));
    },
    async create(input: ScheduleRequest) {
      await lock();
      const { request, nextRunAt } = await validate(input);
      const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const previous = await transaction.execute<{ document: unknown; hash: string }>(sql`
        SELECT document, request_hash AS hash FROM winston.schedules
        WHERE owner_id = ${ownerId}::uuid AND request_key = ${request.key}
      `);
      const row = previous.rows[0];
      if (row) {
        if (row.hash !== hash) throw new ScheduleWriteError("conflict");
        return scheduleSchema.parse(row.document);
      }
      const schedule = scheduleSchema.parse({
        id: randomUUID(),
        ownerId,
        revision: 0,
        state: "active",
        nextRunAt,
        objective: request.objective,
        sourceMessageIds: request.sourceMessageIds,
        timing: request.timing,
      });
      await transaction.execute(sql`
        INSERT INTO winston.schedules (owner_id, id, request_key, request_hash, document, next_run_at)
        VALUES (${ownerId}::uuid, ${schedule.id}::uuid, ${request.key}, ${hash}, ${JSON.stringify(schedule)}::jsonb, ${nextRunAt}::timestamptz)
      `);
      return schedule;
    },
    async update(id: string, revision: number, input: Omit<ScheduleRequest, "key">) {
      const schedule = await current(id, revision);
      if (schedule.state === "canceled") throw new ScheduleWriteError("conflict");
      const { request, nextRunAt } = await validate({ ...input, key: "update" });
      const timingUnchanged =
        new Date(request.timing.startAt).getTime() ===
          new Date(schedule.timing.startAt).getTime() &&
        request.timing.timezone === schedule.timing.timezone &&
        request.timing.kind === schedule.timing.kind &&
        (request.timing.kind === "once" ||
          (schedule.timing.kind === "recurring" && request.timing.rule === schedule.timing.rule));
      await cancelOutstanding(id);
      return save({
        ...schedule,
        objective: request.objective,
        sourceMessageIds: request.sourceMessageIds,
        timing: request.timing,
        revision: revision + 1,
        state: schedule.state === "paused" ? "paused" : timingUnchanged ? schedule.state : "active",
        nextRunAt:
          schedule.state === "paused" ? null : timingUnchanged ? schedule.nextRunAt : nextRunAt,
      });
    },
    async pause(id: string, revision: number) {
      const schedule = await current(id, revision);
      if (schedule.state !== "active") throw new ScheduleWriteError("conflict");
      await cancelOutstanding(id);
      return save({ ...schedule, revision: revision + 1, state: "paused", nextRunAt: null });
    },
    async resume(id: string, revision: number) {
      const schedule = await current(id, revision);
      if (schedule.state !== "paused") throw new ScheduleWriteError("conflict");
      const clock = await transaction.execute<{ now: string }>(
        sql`SELECT clock_timestamp() AS now`,
      );
      const now = clock.rows[0]?.now;
      if (!now) throw new Error("Database clock is unavailable.");
      const nextRunAt =
        schedule.timing.kind === "once"
          ? schedule.timing.startAt
          : nextScheduleOccurrence(schedule.timing, now);
      return save({
        ...schedule,
        revision: revision + 1,
        state: nextRunAt ? "active" : "completed",
        nextRunAt,
      });
    },
    async cancel(id: string, revision: number) {
      const schedule = await current(id, revision);
      await cancelOutstanding(id);
      return save({ ...schedule, revision: revision + 1, state: "canceled", nextRunAt: null });
    },
    async claimDue() {
      await lock();
      const result = await transaction.execute<{ document: unknown; now: string }>(sql`
        SELECT s.document, clock_timestamp() AS now FROM winston.schedules s
        WHERE s.owner_id = ${ownerId}::uuid AND s.document->>'state' = 'active'
          AND s.next_run_at <= clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM winston.schedule_occurrences o JOIN winston.tasks t
              ON t.owner_id = o.owner_id AND t.id = o.task_id
            WHERE o.owner_id = s.owner_id AND o.schedule_id = s.id
              AND t.document->>'state' IN ('queued', 'running', 'waiting')
          )
        ORDER BY s.next_run_at, s.id LIMIT 1
      `);
      const row = result.rows[0];
      if (!row) return undefined;
      const schedule = scheduleSchema.parse(row.document);
      if (!schedule.nextRunAt) return undefined;
      const occurrence = recoverScheduleOccurrence(schedule.timing, schedule.nextRunAt, row.now);
      if (!occurrence) return undefined;
      const task = await tasks.create({
        key: `schedule:${schedule.id}:${String(schedule.revision)}:${occurrence.dueAt}`,
        objective: schedule.objective,
        sourceMessageIds: schedule.sourceMessageIds,
      });
      await transaction.execute(sql`
        INSERT INTO winston.schedule_occurrences (owner_id, schedule_id, revision, due_at, task_id)
        VALUES (${ownerId}::uuid, ${schedule.id}::uuid, ${schedule.revision}, ${occurrence.dueAt}::timestamptz, ${task.id}::uuid)
      `);
      await save({
        ...schedule,
        revision: schedule.revision + 1,
        state: occurrence.nextRunAt ? "active" : "completed",
        nextRunAt: occurrence.nextRunAt,
      });
      return { scheduleId: schedule.id, dueAt: occurrence.dueAt, task };
    },
  };
}
