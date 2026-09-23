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
import { taskResourceRepository } from "./task-resources";
import { connectionTargetKey } from "./connection-target-key";

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
      const binding = await taskResourceRepository(transaction, ownerId).find(
        selection.task,
        connectionTargetKey(selection),
      );
      if (!binding) return undefined;
      if (
        binding.authorization.target.kind !== "connection" ||
        binding.authorization.operation !== selection.operation
      )
        throw new Error("Task resource binding does not match operation.");
      return {
        connectionId: binding.authorization.target.id,
        calendarId: binding.authorization.target.resource,
      };
    },
    // Explicit reads bind each resource independently. Implicit selections and mutations stay pinned.
    async bind(selection: TargetSelection, target: ConnectionTarget) {
      await lock();
      if (!selection.task || !(await currentTask(selection))) throw new Error("Task changed.");
      const parsed = connectionTargetSchema.parse(target);
      await taskResourceRepository(transaction, ownerId).bind({
        task: selection.task,
        key: connectionTargetKey(selection),
        authorization: {
          operation: selection.operation,
          target: { kind: "connection", id: parsed.connectionId, resource: parsed.calendarId },
        },
      });
    },
  };
}
export type ConnectionTargetRepository = ReturnType<typeof connectionTargetRepository>;
