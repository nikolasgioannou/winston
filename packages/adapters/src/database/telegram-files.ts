import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { actionTaskSchema, type ActionTask } from "@winston/contracts/actions";
import { artifactSchema } from "@winston/contracts/artifacts";
import { authorizationSnapshotSchema } from "@winston/contracts/authorization";
import type { TelegramSendOutcome } from "../telegram/send";
import { maximumTelegramDocumentBytes } from "../telegram/document";
import type { DatabaseTransaction } from "./owners";
import { artifactRepository } from "./artifacts";
import { authorizationRepository } from "./authorization";
import { responsibilityTaskAllowed } from "./responsibility-bindings";
import { fileDeliveryPlan } from "./file-delivery-plan";
import { prepareFileDelivery, type FileDeliveryDispatch } from "./file-delivery-preparation";
import { actionRepository } from "./actions";
import { canonicalJson } from "@winston/contracts/json";

export type FileDeliveryInput = {
  key: string;
  botId: number;
  artifactId: string;
  task: ActionTask;
  workspaceId: string;
};
export type FileRow = {
  id: string;
  taskId: string;
  intentRevision: number;
  artifactId: string;
  transferId: string | null;
  readActionId: string | null;
  botId: string;
  chatId: string;
  authorization: unknown;
  state: "pending" | "preparing" | "sending" | "uncertain" | "delivered" | "failed" | "canceled";
  token: string | null;
  expired: boolean;
  messageId: string | null;
};
export type TelegramFileDelivery = {
  id: string;
  token: string;
  artifactId: string;
  chatId: string;
  name: string;
  method: "document" | "link";
};

export function telegramFileRepository(transaction: DatabaseTransaction, ownerId: string) {
  const fields = sql`id, task_id AS "taskId", intent_revision AS "intentRevision", artifact_id AS "artifactId",
    staging_transfer_id AS "transferId", read_action_id AS "readActionId", bot_id::text AS "botId", chat_id::text AS "chatId", permission_snapshot AS authorization, state, lease_token AS token,
    message_id::text AS "messageId", COALESCE(leased_until <= clock_timestamp(), true) AS expired`;
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function find(id: string) {
    artifactSchema.shape.id.parse(id);
    const rows = await transaction.execute<FileRow>(sql`
      SELECT ${fields} FROM winston.telegram_files WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    return rows.rows[0];
  }
  async function eligible(row: FileRow, dispatching = false) {
    const rows = await transaction.execute(sql`
      SELECT 1 FROM winston.tasks t JOIN winston.telegram_bindings b ON b.owner_id = t.owner_id
      JOIN winston.artifacts a ON a.owner_id = t.owner_id AND a.id = ${row.artifactId}::uuid
      WHERE t.owner_id = ${ownerId}::uuid AND t.id = ${row.taskId}::uuid
        AND t.intent_revision = ${row.intentRevision} AND t.document->>'state' NOT IN ('canceled', 'failed')
        AND b.bot_id = ${row.botId}::bigint AND b.chat_id = ${row.chatId}::bigint
        AND a.document->>'state' = 'ready'
        AND (
          NOT ${dispatching} OR (a.document->'metadata'->>'size')::bigint BETWEEN 1 AND ${maximumTelegramDocumentBytes}
          OR EXISTS (SELECT 1 FROM winston.telegram_files f WHERE f.owner_id = ${ownerId}::uuid
            AND f.id = ${row.id}::uuid AND f.created_at > clock_timestamp() - interval '24 hours')
        )
    `);
    if (!rows.rowCount) return false;
    const snapshot = authorizationSnapshotSchema.parse(row.authorization);
    if (snapshot.target.kind !== "workspace" || snapshot.operation !== "workspace.file.read")
      return false;
    const plan = await fileDeliveryPlan(
      transaction,
      ownerId,
      {
        artifactId: row.artifactId,
        workspaceId: snapshot.target.id,
        taskId: row.taskId,
        intentRevision: row.intentRevision,
        botId: Number(row.botId),
      },
      row.transferId ?? undefined,
    );
    if (!plan || plan.chatId !== row.chatId || plan.stagingTransferId !== row.transferId)
      return false;
    if (
      !(await responsibilityTaskAllowed(transaction, ownerId, row.taskId, {
        operation: snapshot.operation,
        target: snapshot.target,
      }))
    )
      return false;
    const policy = await authorizationRepository(transaction, ownerId).evaluate(
      { operation: snapshot.operation, target: snapshot.target },
      snapshot,
    );
    if (policy.decision === "deny") return false;
    if (!row.readActionId) return policy.decision === "allow";
    return actionRepository(transaction, ownerId).authorizeFileDelivery({
      id: row.readActionId,
      plan,
      proof: {
        kind: "receipt",
        taskId: row.taskId,
        intentRevision: row.intentRevision,
        deliveryId: row.id,
      },
    });
  }
  async function cancel(id: string) {
    await transaction.execute(sql`
      UPDATE winston.telegram_files SET state = 'canceled', lease_token = NULL, leased_until = NULL
      WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
  }

  const repository = {
    find,
    async downloadAccess(id: string) {
      await lock();
      const row = await find(id);
      if (!row || ["failed", "canceled"].includes(row.state) || !(await eligible(row)))
        return { kind: "unavailable" as const };
      const lifetime = await transaction.execute<{ expiresAt: string; remaining: number }>(sql`
        SELECT created_at + interval '24 hours' AS "expiresAt",
          floor(extract(epoch FROM (created_at + interval '24 hours' - clock_timestamp())))::integer AS remaining
        FROM winston.telegram_files WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);
      const access = lifetime.rows[0];
      if (!access || access.remaining <= 1) return { kind: "expired" as const };
      // Keep deletion behind the local signing operation in this same transaction.
      const artifact = await artifactRepository(transaction, ownerId).find(row.artifactId, true);
      if (artifact?.state !== "ready") return { kind: "unavailable" as const };
      return { kind: "ready" as const, artifact, ...access };
    },
    async enqueue(input: FileDeliveryInput, proof?: FileDeliveryDispatch) {
      if (!input.key || input.key.length > 100 || !Number.isSafeInteger(input.botId))
        throw new Error("Invalid file delivery identity.");
      const task = actionTaskSchema.parse(input.task);
      await lock();
      const rows = await transaction.execute<{ intentRevision: number }>(sql`
        SELECT intent_revision AS "intentRevision" FROM winston.tasks
        WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid
          AND (document->>'revision')::integer = ${task.revision}
          AND (document->>'generation')::integer = ${task.generation}
          AND document->>'state' = 'running' AND leased_until > clock_timestamp()
      `);
      const current = rows.rows[0];
      if (!current) throw new Error("Task authority unavailable.");
      const key = `file:${task.id}:${String(current.intentRevision)}:${createHash("sha256").update(input.key).digest("hex")}`;
      const existing = await transaction.execute<FileRow>(sql`
        SELECT ${fields} FROM winston.telegram_files WHERE owner_id = ${ownerId}::uuid AND request_key = ${key}
      `);
      const previous = existing.rows[0];
      if (previous) {
        if (previous.artifactId !== input.artifactId || previous.botId !== String(input.botId))
          throw new Error("File delivery key conflicts with its original request.");
        return previous;
      }
      const plan = await fileDeliveryPlan(
        transaction,
        ownerId,
        {
          ...input,
          taskId: task.id,
          intentRevision: current.intentRevision,
        },
        proof?.plan.stagingTransferId ?? undefined,
      );
      if (!plan) throw new Error("Artifact is unavailable to this task.");
      if (proof && canonicalJson(proof.plan) !== canonicalJson(plan))
        throw new Error("File approval no longer matches this delivery.");
      const approved = proof
        ? await actionRepository(transaction, ownerId).authorizeFileDelivery({
            id: proof.id,
            plan,
            proof: { kind: "dispatch", task, token: proof.token },
          })
        : false;
      if (proof && !approved) throw new Error("File approval is unavailable.");
      const policy = await authorizationRepository(transaction, ownerId).evaluate({
        operation: "workspace.file.read",
        target: { kind: "workspace", id: input.workspaceId, resource: null },
      });
      if (
        !(await responsibilityTaskAllowed(transaction, ownerId, task.id, {
          operation: "workspace.file.read",
          target: { kind: "workspace", id: input.workspaceId, resource: null },
        }))
      )
        throw new Error("File access is not allowed.");
      if (
        policy.decision === "deny" ||
        (policy.decision !== "allow" && !approved) ||
        !policy.snapshot
      )
        throw new Error("File access is not allowed.");
      const id = randomUUID();
      await transaction.execute(sql`
        INSERT INTO winston.telegram_files (owner_id, id, request_key, task_id, intent_revision, artifact_id, bot_id, chat_id, permission_snapshot, staging_transfer_id, read_action_id)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${key}, ${task.id}::uuid, ${current.intentRevision}, ${plan.artifactId}::uuid,
          ${input.botId}, ${plan.chatId}::bigint, ${JSON.stringify(policy.snapshot)}::jsonb, ${plan.stagingTransferId}::uuid, ${proof?.id ?? null}::uuid)
      `);
      const created = await find(id);
      if (!created) throw new Error("File delivery could not be recorded.");
      return created;
    },
    async claim(botId: number): Promise<TelegramFileDelivery | undefined> {
      await lock();
      // Expired dispatch is never retried. Preparation has no external effect and can be reclaimed.
      await transaction.execute(sql`
        UPDATE winston.telegram_files SET state = 'uncertain'
        WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId} AND state = 'sending' AND leased_until <= clock_timestamp()
      `);
      const rows = await transaction.execute<FileRow>(sql`
        SELECT ${fields} FROM winston.telegram_files WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}
          AND available_at <= clock_timestamp() AND (state = 'pending' OR (state = 'preparing' AND leased_until <= clock_timestamp()))
        ORDER BY sequence LIMIT 1 FOR UPDATE
      `);
      const row = rows.rows[0];
      if (!row) return undefined;
      if (!(await eligible(row, true))) {
        await cancel(row.id);
        return undefined;
      }
      const token = randomUUID();
      const artifact = await artifactRepository(transaction, ownerId).find(row.artifactId);
      if (artifact?.state !== "ready") {
        await cancel(row.id);
        return undefined;
      }
      await transaction.execute(sql`
        UPDATE winston.telegram_files SET state = 'preparing', lease_token = ${token}::uuid, leased_until = clock_timestamp() + interval '90 seconds'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return {
        id: row.id,
        token,
        artifactId: row.artifactId,
        chatId: row.chatId,
        name: artifact.metadata.name,
        method:
          artifact.object.size === 0 || artifact.object.size > maximumTelegramDocumentBytes
            ? "link"
            : "document",
      };
    },
    async dispatch(delivery: TelegramFileDelivery) {
      await lock();
      const row = await find(delivery.id);
      if (!row || row.state !== "preparing" || row.token !== delivery.token || row.expired)
        return false;
      if (!(await eligible(row, true))) {
        await cancel(row.id);
        return false;
      }
      await transaction.execute(sql`
        UPDATE winston.telegram_files SET state = 'sending', leased_until = clock_timestamp() + interval '90 seconds'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return true;
    },
    async settle(delivery: TelegramFileDelivery, outcome: TelegramSendOutcome) {
      await lock();
      const row = await find(delivery.id);
      if (
        !row ||
        row.token !== delivery.token ||
        !["preparing", "sending", "uncertain"].includes(row.state)
      )
        return false;
      if (row.state === "preparing" && !["retry", "rejected"].includes(outcome.state)) return false;
      const state =
        outcome.state === "sent"
          ? "delivered"
          : outcome.state === "retry"
            ? "pending"
            : outcome.state === "rejected"
              ? "failed"
              : "uncertain";
      const delay =
        outcome.state === "retry" ? Math.max(1, Math.min(outcome.afterSeconds, 86_400)) : 0;
      await transaction.execute(sql`
        UPDATE winston.telegram_files SET state = ${state}, message_id = ${outcome.state === "sent" ? outcome.messageId : null},
          lease_token = ${state === "uncertain" ? delivery.token : null}::uuid, leased_until = NULL,
          available_at = clock_timestamp() + ${delay} * interval '1 second'
        WHERE owner_id = ${ownerId}::uuid AND id = ${row.id}::uuid
      `);
      return true;
    },
  };
  return {
    ...repository,
    prepare: (input: FileDeliveryInput) =>
      prepareFileDelivery(transaction, ownerId, input, repository),
  };
}
