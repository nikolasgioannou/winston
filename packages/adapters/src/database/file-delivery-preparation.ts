import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { actionRecordSchema, actionTaskSchema } from "@winston/contracts/actions";
import { fileDeliveryPlanSchema, type FileDeliveryPlan } from "@winston/contracts/artifacts";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";
import type { FileDeliveryInput, FileRow } from "./telegram-files";
import { actionRepository } from "./actions";
import { taskRepository } from "./tasks";
import { authorizationRepository } from "./authorization";
import { fileDeliveryPlan } from "./file-delivery-plan";
import { responsibilityTaskAllowed } from "./responsibility-bindings";

export type FileDeliveryDispatch = { id: string; token: string; plan: FileDeliveryPlan };
export type FileDeliveryPreparation =
  | { kind: "delivery"; delivery: FileRow }
  | { kind: "waiting"; actionId: string }
  | { kind: "denied" }
  | { kind: "unknown"; actionId: string };

export async function prepareFileDelivery(
  transaction: DatabaseTransaction,
  ownerId: string,
  input: FileDeliveryInput,
  callbacks: {
    find: (id: string) => Promise<FileRow | undefined>;
    enqueue: (input: FileDeliveryInput, proof?: FileDeliveryDispatch) => Promise<FileRow>;
  },
): Promise<FileDeliveryPreparation> {
  if (!input.key || input.key.length > 100 || !Number.isSafeInteger(input.botId))
    return { kind: "denied" };
  const worker = actionTaskSchema.parse(input.task);
  await transaction.execute(
    sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
  );
  const tasks = await transaction.execute<{ intentRevision: number }>(sql`
    SELECT intent_revision AS "intentRevision" FROM winston.tasks
    WHERE owner_id = ${ownerId}::uuid AND id = ${worker.id}::uuid
      AND (document->>'revision')::integer = ${worker.revision}
      AND (document->>'generation')::integer = ${worker.generation}
      AND document->>'state' = 'running' AND leased_until > clock_timestamp()
  `);
  const current = tasks.rows[0];
  if (!current) return { kind: "denied" };
  const key = `file:${worker.id}:${String(current.intentRevision)}:${createHash("sha256").update(input.key).digest("hex")}`;
  const queued = await transaction.execute<{ id: string }>(sql`
    SELECT id FROM winston.telegram_files WHERE owner_id = ${ownerId}::uuid AND request_key = ${key}
  `);
  if (queued.rows[0]) {
    const delivery = await callbacks.find(queued.rows[0].id);
    if (
      !delivery ||
      delivery.artifactId !== input.artifactId ||
      delivery.botId !== String(input.botId)
    )
      return { kind: "denied" };
    return { kind: "delivery", delivery };
  }
  const previous = await transaction.execute<{ document: unknown }>(sql`
    SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND request_key = ${`delivery:${key}`}
  `);
  const existing = previous.rows[0] ? actionRecordSchema.parse(previous.rows[0].document) : null;
  const original = existing ? fileDeliveryPlanSchema.parse(existing.request.arguments) : null;
  const plan = await fileDeliveryPlan(
    transaction,
    ownerId,
    {
      ...input,
      taskId: worker.id,
      intentRevision: current.intentRevision,
    },
    original?.stagingTransferId ?? undefined,
  );
  if (!plan) return { kind: "denied" };
  const authorization = {
    operation: "workspace.file.read" as const,
    target: { kind: "workspace" as const, id: input.workspaceId, resource: null },
  };
  const policy = await authorizationRepository(transaction, ownerId).evaluate(
    authorization,
    existing?.snapshot ?? undefined,
  );
  if (
    policy.decision === "deny" ||
    !(await responsibilityTaskAllowed(transaction, ownerId, worker.id, authorization))
  )
    return { kind: "denied" };
  if (!existing && policy.decision === "allow")
    return { kind: "delivery", delivery: await callbacks.enqueue(input) };
  if (original && canonicalJson(original) !== canonicalJson(plan)) return { kind: "denied" };
  const actions = actionRepository(transaction, ownerId);
  const action =
    existing ??
    (await actions.prepare({
      key: `delivery:${key}`,
      task: worker,
      authorization,
      arguments: plan,
    }));
  if (["denied", "invalidated", "failed"].includes(action.state)) return { kind: "denied" };
  if (action.state === "pending") {
    if ((await actions.expirePending(action.id))?.state !== "pending") return { kind: "denied" };
    await taskRepository(transaction, ownerId).finishStep(
      worker.id,
      worker.revision,
      worker.generation,
      {
        state: "waiting",
        blocker: {
          kind: "approval",
          referenceId: action.id,
          detail: "Waiting for permission to deliver this exact file.",
        },
      },
    );
    return { kind: "waiting", actionId: action.id };
  }
  const claim = await actions.claim(action.id, action.hash, worker);
  if (!claim?.claimed) return { kind: "unknown", actionId: action.id };
  const delivery = await callbacks.enqueue(input, { id: action.id, token: claim.token, plan });
  if (
    !(await actions.report(action.id, claim.token, {
      state: "succeeded",
      providerReference: delivery.id,
      detail: "Exact file read approved and queued; Telegram delivery is tracked separately.",
    }))
  )
    throw new Error("File delivery approval could not be recorded.");
  return { kind: "delivery", delivery };
}
