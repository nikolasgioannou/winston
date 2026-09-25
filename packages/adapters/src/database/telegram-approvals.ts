import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  telegramApprovalCallbackSchema,
  type TelegramApprovalCallback,
} from "@winston/contracts/telegram";
import { actionRecordSchema } from "@winston/contracts/actions";
import { formatCalendarMutationApproval } from "../google/calendar-mutation-review";
import { formatGmailMutationApproval } from "../google/gmail-mutation-review";
import { formatGmailLabelMutationApproval } from "../google/gmail-label-mutation-review";
import { formatGmailTrashApproval } from "../google/gmail-trash-review";
import { formatFileDeliveryApproval } from "../artifacts/delivery-review";
import { actionRepository } from "./actions";
import { telegramOutboundRepository } from "./telegram-outbound";
import type { DatabaseTransaction } from "./owners";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Result = "approved" | "denied" | "invalidated";

export function telegramApprovalRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const owner = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!owner.rowCount) throw new Error("Owner unavailable.");
  }

  return {
    async prepare(inputId: string, inputBotId: number) {
      const id = actionRecordSchema.shape.id.parse(inputId);
      const botId = telegramApprovalCallbackSchema.shape.botId.parse(inputBotId);
      await lock();
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT a.document FROM winston.actions a
        JOIN winston.tasks t ON t.owner_id = a.owner_id AND t.id = a.task_id
        WHERE a.owner_id = ${ownerId}::uuid AND a.id = ${id}::uuid
          AND a.document->>'state' = 'pending' AND a.expires_at > clock_timestamp()
          AND (a.document->>'intentRevision')::integer = t.intent_revision
          AND t.document->>'state' = 'waiting'
          AND t.document->'blocker'->>'kind' = 'approval'
          AND t.document->'blocker'->>'referenceId' = a.id::text
      `);
      if (!rows.rows[0]) return null;
      const action = actionRecordSchema.parse(rows.rows[0].document);
      const existing = await transaction.execute<{ outboundId: string }>(sql`
        SELECT outbound_id AS "outboundId" FROM winston.telegram_approvals
        WHERE owner_id = ${ownerId}::uuid AND action_id = ${id}::uuid AND revision = ${action.revision} AND bot_id = ${botId}
      `);
      if (existing.rows[0]) return existing.rows[0];
      const bindings = await transaction.execute<{ userId: string; chatId: string }>(sql`
        SELECT user_id::text AS "userId", chat_id::text AS "chatId" FROM winston.telegram_bindings
        WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}
      `);
      const binding = bindings.rows[0];
      if (!binding) return null;
      const approve = `ap_${randomBytes(32).toString("base64url")}`;
      const reject = `ap_${randomBytes(32).toString("base64url")}`;
      const target = action.request.authorization.target;
      const text =
        action.request.authorization.operation === "calendar.write"
          ? formatCalendarMutationApproval(action)
          : action.request.authorization.operation === "gmail.trash"
            ? formatGmailTrashApproval(action)
            : action.request.authorization.operation === "gmail.modify"
              ? formatGmailLabelMutationApproval(action)
              : ["gmail.draft", "gmail.send"].includes(action.request.authorization.operation)
                ? formatGmailMutationApproval(action)
                : (formatFileDeliveryApproval(action) ??
                  [
                    "Approval needed",
                    `Action: ${action.request.authorization.operation}`,
                    `Target: ${target.kind} ${target.id}${target.resource ? ` / ${target.resource}` : ""}`,
                    "Details:",
                    JSON.stringify(action.request.arguments, null, 2),
                    `Expires: ${action.expiresAt}`,
                  ].join("\n"));
      const outboundId = await telegramOutboundRepository(transaction, ownerId).enqueue(
        `approval:${String(botId)}:${id}:${String(action.revision)}`,
        botId,
        text,
        {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: approve },
              { text: "Reject", callback_data: reject },
            ],
          ],
        },
      );
      await transaction.execute(sql`
        INSERT INTO winston.telegram_approvals (owner_id, action_id, revision, action_hash, bot_id, user_id, chat_id, outbound_id, approve_hash, reject_hash)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${action.revision}, ${action.hash}, ${botId}, ${binding.userId}::bigint,
          ${binding.chatId}::bigint, ${outboundId}::uuid, ${hash(approve)}, ${hash(reject)})
      `);
      return { outboundId };
    },
    // Only a trusted Telegram ingress may supply the verified sender and source message.
    async decide(
      input: TelegramApprovalCallback,
    ): Promise<{ state: Result; duplicate: boolean } | null> {
      const parsed = telegramApprovalCallbackSchema.safeParse(input);
      if (!parsed.success) return null;
      const callback = parsed.data;
      await lock();
      const digest = hash(callback.token);
      const rows = await transaction.execute<{
        actionId: string;
        revision: number;
        actionHash: string;
        approve: boolean;
        result: Result | null;
      }>(sql`
        SELECT p.action_id AS "actionId", p.revision, p.action_hash AS "actionHash",
          p.approve_hash = ${digest} AS approve, p.result
        FROM winston.telegram_approvals p
        JOIN winston.actions a ON a.owner_id = p.owner_id AND a.id = p.action_id
        JOIN winston.tasks t ON t.owner_id = a.owner_id AND t.id = a.task_id
        JOIN winston.telegram_bindings b ON b.owner_id = p.owner_id AND b.bot_id = p.bot_id
          AND b.user_id = p.user_id AND b.chat_id = p.chat_id
        JOIN winston.telegram_outbound o ON o.owner_id = p.owner_id AND o.id = p.outbound_id
        WHERE p.owner_id = ${ownerId}::uuid AND p.bot_id = ${callback.botId}
          AND p.user_id = ${callback.userId} AND p.chat_id = ${callback.chatId}
          AND (p.approve_hash = ${digest} OR p.reject_hash = ${digest})
          AND o.bot_id = p.bot_id AND o.chat_id = p.chat_id AND o.state = 'delivered'
          AND o.sent_ids->>-1 = ${String(callback.messageId)}
          AND (p.result IS NOT NULL OR (
            t.document->>'state' = 'waiting' AND t.document->'blocker'->>'kind' = 'approval'
            AND t.document->'blocker'->>'referenceId' = p.action_id::text
          ))
        FOR UPDATE OF p
      `);
      const proposal = rows.rows[0];
      if (!proposal) return null;
      if (proposal.result) return { state: proposal.result, duplicate: true };
      const action = await actionRepository(transaction, ownerId).decide({
        id: proposal.actionId,
        revision: proposal.revision,
        hash: proposal.actionHash,
        approve: proposal.approve,
      });
      const state =
        action?.state === "approved"
          ? "approved"
          : action?.state === "denied"
            ? "denied"
            : "invalidated";
      await transaction.execute(sql`
        UPDATE winston.telegram_approvals SET result = ${state}
        WHERE owner_id = ${ownerId}::uuid AND action_id = ${proposal.actionId}::uuid
          AND revision = ${proposal.revision} AND bot_id = ${callback.botId}
      `);
      return { state, duplicate: false };
    },
  };
}
