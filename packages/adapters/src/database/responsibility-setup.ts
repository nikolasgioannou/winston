import { sql } from "drizzle-orm";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { taskRepository } from "./tasks";

async function setup(transaction: DatabaseTransaction, ownerId: string, id: string) {
  const result = await transaction.execute<{ document: unknown; current: boolean }>(sql`
    SELECT t.document, t.intent_revision = q.intent_revision AS current
    FROM winston.responsibility_requests q
    JOIN winston.tasks t ON t.owner_id = q.owner_id AND t.id = q.task_id
    WHERE q.owner_id = ${ownerId}::uuid AND q.responsibility_id = ${id}::uuid
  `);
  const row = result.rows[0];
  return row ? { task: taskSchema.parse(row.document), current: row.current } : undefined;
}

// The caller holds the owner lock for the agreement/lifecycle transaction.
export async function cancelResponsibilitySetup(
  transaction: DatabaseTransaction,
  ownerId: string,
  id: string,
) {
  const previous = await setup(transaction, ownerId, id);
  if (previous?.current && ["queued", "running", "waiting"].includes(previous.task.state))
    await taskRepository(transaction, ownerId).cancel(previous.task.id, previous.task.revision);
}

export async function resumeResponsibilitySetup(
  transaction: DatabaseTransaction,
  ownerId: string,
  value: Responsibility,
) {
  if (value.state !== "active" || !value.agreement)
    throw new Error("Responsibility agreement is missing.");
  const previous = await setup(transaction, ownerId, value.id);
  const tasks = taskRepository(transaction, ownerId);
  if (
    previous?.current &&
    previous.task.state === "waiting" &&
    previous.task.blocker?.kind === "responsibility" &&
    previous.task.blocker.referenceId === value.id
  ) {
    await tasks.resume(previous.task.id, previous.task.revision, value.id);
    return;
  }
  if (previous) {
    const history = await transaction.execute(sql`
      SELECT revision FROM winston.responsibility_history WHERE owner_id = ${ownerId}::uuid
        AND responsibility_id = ${value.id}::uuid AND revision < ${value.agreement.proposalRevision}
        AND document->'agreement'->>'proposalRevision' IS NOT NULL LIMIT 1
    `);
    // An initial proposal whose task was canceled or steered cannot restart that work.
    // A newly agreed revision of an existing responsibility gets separate setup instead.
    if (!history.rowCount) return;
    if (previous.current && ["queued", "running", "waiting"].includes(previous.task.state))
      throw new Error("Previous responsibility setup is still active.");
  }
  const task = await tasks.create({
    key: `responsibility:${value.id}:agreement:${String(value.agreement.proposalRevision)}`,
    objective: `Configure scheduled checks for the agreed responsibility: ${value.purpose}`,
    sourceMessageIds: value.sources.map((source) => source.messageId),
  });
  await transaction.execute(sql`
    INSERT INTO winston.responsibility_requests (owner_id, responsibility_id, task_id, intent_revision)
    SELECT ${ownerId}::uuid, ${value.id}::uuid, id, intent_revision FROM winston.tasks
      WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid
    ON CONFLICT (owner_id, responsibility_id) DO UPDATE
      SET task_id = EXCLUDED.task_id, intent_revision = EXCLUDED.intent_revision
  `);
}
