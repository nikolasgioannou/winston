import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  cliResponsibilityRequestSchema,
  cliResultSchema,
  type CliResponsibilityRequest,
  type CliResult,
} from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { responsibilityRepository } from "./responsibilities";
import { taskRepository } from "./tasks";
import { taskResponsibilityBinding } from "./responsibility-bindings";

export async function executeResponsibilityCommand(
  transaction: DatabaseTransaction,
  ownerId: string,
  credential: ServiceRequest,
  input: CliResponsibilityRequest,
): Promise<CliResult> {
  const request = cliResponsibilityRequestSchema.parse(input);
  await transaction.execute(
    sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
  );
  const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
  const proposes = request.command === "responsibilities.propose";
  if (!authority || authority.operation !== (proposes ? "gateway:control" : "gateway:read"))
    return { version: 1, status: "denied", message: "Task authority is unavailable or expired." };
  const responsibilities = responsibilityRepository(transaction, ownerId);
  if (request.command === "responsibilities.list") {
    const items = await responsibilities.list(request.after);
    return cliResultSchema.parse({
      version: 1,
      status: "ok",
      data: { items, next: items.length === 100 ? items.at(-1)?.id : null },
    });
  }
  if (request.command === "responsibilities.inspect") {
    const item = await responsibilities.find(request.id);
    return item
      ? cliResultSchema.parse({ version: 1, status: "ok", data: item })
      : { version: 1, status: "unavailable", message: "Responsibility unavailable." };
  }
  if (await taskResponsibilityBinding(transaction, ownerId, authority.taskId))
    return {
      version: 1,
      status: "denied",
      message: "A responsibility check cannot create another responsibility.",
    };
  const tasks = taskRepository(transaction, ownerId);
  const worker = {
    id: authority.taskId,
    revision: authority.revision,
    generation: authority.generation,
  };
  const context = await tasks.context(worker);
  const rows = await transaction.execute<{ intent: number }>(
    sql`SELECT intent_revision AS intent FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${worker.id}::uuid`,
  );
  const intent = rows.rows[0]?.intent;
  if (intent === undefined) throw new Error("Task unavailable.");
  const key = `cli:${worker.id}:${String(intent)}:${createHash("sha256").update(request.key).digest("hex")}`;
  const previous = await transaction.execute<{ id: string }>(
    sql`SELECT responsibility_id AS id FROM winston.responsibility_requests WHERE owner_id = ${ownerId}::uuid AND task_id = ${worker.id}::uuid AND intent_revision = ${intent}`,
  );
  const proposed = await responsibilities.propose({
    key,
    purpose: request.purpose,
    scope: request.scope,
    sourceMessageIds: context.task.sourceMessageIds,
  });
  if (previous.rows[0] && previous.rows[0].id !== proposed.id)
    throw new Error("This task already has a responsibility proposal.");
  if (proposed.state === "active")
    return cliResultSchema.parse({ version: 1, status: "ok", data: proposed });
  if (proposed.state !== "proposed")
    return { version: 1, status: "denied", message: "This responsibility is paused or ended." };
  await tasks.finishStep(worker.id, worker.revision, worker.generation, {
    state: "waiting",
    blocker: {
      kind: "responsibility",
      referenceId: proposed.id,
      detail: proposed.purpose.slice(0, 2000),
    },
  });
  await transaction.execute(sql`
    INSERT INTO winston.responsibility_requests (owner_id, responsibility_id, task_id, intent_revision)
    VALUES (${ownerId}::uuid, ${proposed.id}::uuid, ${worker.id}::uuid, ${intent}) ON CONFLICT DO NOTHING
  `);
  return {
    version: 1,
    status: "waiting",
    referenceId: proposed.id,
    message:
      "Waiting for the owner to review and agree in the web app. This proposal has not started monitoring.",
  };
}
