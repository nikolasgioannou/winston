import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { inboxTransferSchema, inboxTransferTokenSchema } from "@winston/contracts/artifacts";
import { userMessageSchema } from "@winston/contracts/messages";
import type { DatabaseTransaction } from "./owners";
import { capabilityHash } from "./capabilities";
import { conversationRepository } from "./conversations";

export function inboxTransferRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function authenticate(token: string) {
    if (!inboxTransferTokenSchema.safeParse(token).success) return null;
    await lock();
    const rows = await transaction.execute<{ document: unknown; envelope: unknown }>(sql`
      SELECT jsonb_build_object('ownerId', i.owner_id, 'intakeId', i.id, 'workspaceId', w.id,
        'workspaceRevision', w.revision, 'artifactId', a.id,
        'size', (a.document->'metadata'->>'size')::bigint, 'sha256', a.document->'metadata'->>'sha256') AS document,
        m.envelope FROM winston.inbox_transfers t
      JOIN winston.telegram_intake i ON i.owner_id = t.owner_id AND i.id = t.intake_id
      JOIN winston.workspaces w ON w.owner_id = t.owner_id AND w.id = t.workspace_id
      JOIN winston.artifacts a ON a.owner_id = i.owner_id AND a.id = i.artifact_id
      JOIN winston.conversation_messages m ON m.owner_id = i.owner_id AND m.id = i.message_id
      JOIN winston.telegram_bindings b ON b.owner_id = m.owner_id AND b.bot_id = m.bot_id AND b.chat_id = m.chat_id
      WHERE t.owner_id = ${ownerId}::uuid AND t.token_hash = ${capabilityHash(token)}
        AND t.expires_at > clock_timestamp() AND i.state = 'stored' AND a.document->>'state' = 'ready'
        AND w.state = 'active' AND w.revision = t.workspace_revision
    `);
    const row = rows.rows[0];
    if (!row) return null;
    const transfer = inboxTransferSchema.parse(row.document);
    const message = userMessageSchema.parse(row.envelope);
    if (
      !message.metadata.attachments.some((a) => a.id === transfer.intakeId && a.state === "pending")
    )
      return null;
    return { transfer, message };
  }
  return {
    async authenticate(token: string) {
      return (await authenticate(token))?.transfer ?? null;
    },
    async claim(botId: number) {
      await lock();
      // A single active cloud home is required. Multiple candidates need explicit selection.
      const workspaces = await transaction.execute<{
        id: string;
        revision: number;
        origin: string;
      }>(sql`
        SELECT w.id, w.revision, r.origin FROM winston.workspaces w JOIN winston.workspace_runtimes r
          ON r.owner_id = w.owner_id AND r.workspace_id = w.id
        WHERE w.owner_id = ${ownerId}::uuid AND w.state = 'active' LIMIT 2
      `);
      const workspace = workspaces.rows.length === 1 ? workspaces.rows[0] : undefined;
      if (!workspace) return null;
      const rows = await transaction.execute<{ id: string }>(sql`
        SELECT i.id FROM winston.telegram_intake i WHERE i.owner_id = ${ownerId}::uuid
          AND i.bot_id = ${botId} AND i.state = 'stored' AND i.available_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM winston.inbox_transfers t WHERE t.owner_id = i.owner_id
            AND t.intake_id = i.id AND t.expires_at > clock_timestamp())
        ORDER BY i.created_at, i.id LIMIT 1
      `);
      const intake = rows.rows[0];
      if (!intake) return null;
      const token = `wit_${randomBytes(32).toString("base64url")}`;
      await transaction.execute(sql`
        INSERT INTO winston.inbox_transfers (owner_id, intake_id, workspace_id, workspace_revision, token_hash, expires_at)
        VALUES (${ownerId}::uuid, ${intake.id}::uuid, ${workspace.id}::uuid, ${workspace.revision}, ${capabilityHash(token)}, clock_timestamp() + interval '180 seconds')
        ON CONFLICT (owner_id, intake_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
          workspace_revision = EXCLUDED.workspace_revision, token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at
      `);
      const current = await authenticate(token);
      if (!current) {
        await transaction.execute(sql`UPDATE winston.telegram_intake SET available_at = clock_timestamp() + interval '60 seconds'
          WHERE owner_id = ${ownerId}::uuid AND id = ${intake.id}::uuid`);
        return null;
      }
      return { token, transfer: current.transfer, origin: workspace.origin };
    },
    async retry(token: string) {
      if (!inboxTransferTokenSchema.safeParse(token).success) return;
      await lock();
      await transaction.execute(sql`
        UPDATE winston.telegram_intake i SET available_at = clock_timestamp() + interval '5 seconds'
        FROM winston.inbox_transfers t WHERE i.owner_id = ${ownerId}::uuid AND i.owner_id = t.owner_id
          AND i.id = t.intake_id AND t.token_hash = ${capabilityHash(token)} AND i.state = 'stored'
      `);
      await transaction.execute(sql`UPDATE winston.inbox_transfers SET expires_at = clock_timestamp()
        WHERE owner_id = ${ownerId}::uuid AND token_hash = ${capabilityHash(token)}`);
    },
    async complete(token: string) {
      const current = await authenticate(token);
      if (!current) return false;
      const { transfer, message } = current;
      await conversationRepository(transaction, ownerId).resolveMessage({
        ...message,
        revision: message.revision + 1,
        metadata: {
          ...message.metadata,
          attachments: message.metadata.attachments.map((attachment) =>
            attachment.id === transfer.intakeId
              ? {
                  ...attachment,
                  state: "staged" as const,
                  artifactId: transfer.artifactId,
                  workspaceId: transfer.workspaceId,
                  path: `/data/inbox/${transfer.artifactId}`,
                  sha256: transfer.sha256,
                  verifiedAt: new Date().toISOString(),
                }
              : attachment,
          ),
        },
      });
      await transaction.execute(sql`UPDATE winston.telegram_intake SET state = 'staged'
        WHERE owner_id = ${ownerId}::uuid AND id = ${transfer.intakeId}::uuid`);
      return true;
    },
  };
}
