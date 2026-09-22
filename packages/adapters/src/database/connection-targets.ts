import { sql } from "drizzle-orm";
import {
  connectionTargetSchema,
  targetPreferencesSchema,
  type ConnectionTarget,
  type TargetPreferences,
  type TargetSelection,
} from "@winston/contracts/connection-targets";
import type { DatabaseTransaction } from "./owners";
import { connectionRepository } from "./connections";
import { taskRepository } from "./tasks";

export function connectionTargetRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const result = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!result.rowCount) throw new Error("Owner unavailable.");
  }
  async function preferences() {
    await lock();
    const rows = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.connection_target_preferences WHERE owner_id = ${ownerId}::uuid
    `);
    return targetPreferencesSchema.parse(
      rows.rows[0]?.document ?? { revision: 0, labels: [], defaults: [] },
    );
  }
  async function currentTask(selection: TargetSelection) {
    if (!selection.task) return true;
    await transaction.execute(
      sql`SELECT id FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${selection.task.id}::uuid FOR UPDATE`,
    );
    const task = await taskRepository(transaction, ownerId).find(selection.task.id);
    return (
      !!task &&
      task.revision === selection.task.revision &&
      ["queued", "running", "waiting"].includes(task.state)
    );
  }
  return {
    preferences,
    currentTask,
    async put(input: TargetPreferences) {
      const next = targetPreferencesSchema.parse(input);
      const current = await preferences();
      if (next.revision !== current.revision) return null;
      if (new Set(next.defaults.map((entry) => entry.operation)).size !== next.defaults.length)
        throw new Error("Duplicate operation default.");
      if (
        new Set(next.labels.map((entry) => JSON.stringify(entry.target))).size !==
        next.labels.length
      )
        throw new Error("Duplicate target label.");
      const connections = connectionRepository(transaction, ownerId);
      for (const entry of [...next.defaults, ...next.labels]) {
        const connection = await connections.find(entry.target.connectionId);
        if (
          !connection ||
          (entry.target.calendarId !== null &&
            (connection.service !== "calendar" ||
              !connection.calendars.includes(entry.target.calendarId)))
        )
          throw new Error("Target unavailable.");
        if (
          "operation" in entry &&
          (!entry.operation.startsWith(`${connection.service}.`) ||
            (connection.service === "calendar" && entry.target.calendarId === null) ||
            (connection.service === "gmail" && entry.target.calendarId !== null))
        )
          throw new Error("Default target does not match operation.");
      }
      const saved = { ...next, revision: current.revision + 1 };
      await transaction.execute(sql`
        INSERT INTO winston.connection_target_preferences (owner_id, document)
        VALUES (${ownerId}::uuid, ${JSON.stringify(saved)}::jsonb)
        ON CONFLICT (owner_id) DO UPDATE SET document = EXCLUDED.document
      `);
      return saved;
    },
    async binding(selection: TargetSelection): Promise<ConnectionTarget | undefined> {
      await lock();
      if (!selection.task) return undefined;
      if (!(await currentTask(selection))) throw new Error("Task changed.");
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.task_connection_targets WHERE owner_id = ${ownerId}::uuid
          AND task_id = ${selection.task.id}::uuid AND task_revision = ${selection.task.revision}
          AND operation = ${selection.operation}
      `);
      return rows.rows[0] ? connectionTargetSchema.parse(rows.rows[0].document) : undefined;
    },
    // Bind once per task revision. Changing accounts requires steering the task to a new revision.
    async bind(selection: TargetSelection, target: ConnectionTarget) {
      await lock();
      if (!selection.task || !(await currentTask(selection))) throw new Error("Task changed.");
      const parsed = connectionTargetSchema.parse(target);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        INSERT INTO winston.task_connection_targets (owner_id, task_id, task_revision, operation, document)
        VALUES (${ownerId}::uuid, ${selection.task.id}::uuid, ${selection.task.revision}, ${selection.operation}, ${JSON.stringify(parsed)}::jsonb)
        ON CONFLICT (owner_id, task_id, task_revision, operation) DO UPDATE
          SET document = winston.task_connection_targets.document
        RETURNING document
      `);
      const stored = connectionTargetSchema.parse(rows.rows[0]?.document);
      if (stored.connectionId !== parsed.connectionId || stored.calendarId !== parsed.calendarId)
        throw new Error("Steer the task before changing its target.");
    },
  };
}
export type ConnectionTargetRepository = ReturnType<typeof connectionTargetRepository>;
