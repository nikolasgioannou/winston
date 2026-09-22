import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { telegramUpdateSchema } from "@winston/contracts/telegram";
import { timestampSnapshot } from "@winston/contracts/timezone";
import { eventRepository } from "../database/events";
import type { DatabaseTransaction } from "../database/owners";
import * as schema from "../database/schema";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createTelegramStore(connectionString: string, botId: number) {
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    maxLifetimeSeconds: 540,
  });
  pool.on("error", () => {
    console.error("Telegram database connection lost.");
  });
  const database = drizzle(pool, { schema });

  async function lockOwner(transaction: DatabaseTransaction, ownerId: string) {
    const owner = await transaction.execute<{ timezone: string }>(sql`
      SELECT timezone FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE
    `);
    if (!owner.rows[0]) throw new Error("Owner profile is unavailable.");

    return owner.rows[0];
  }

  return {
    close: () => pool.end(),
    async challenge(ownerId: string, sessionId: string) {
      const secret = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await database.transaction(async (transaction) => {
        await lockOwner(transaction, ownerId);
        await transaction.execute(
          sql`DELETE FROM winston.telegram_challenges WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}`,
        );
        await transaction.execute(sql`
          INSERT INTO winston.telegram_challenges (id, owner_id, bot_id, session_hash, secret_hash, expires_at)
          VALUES (${id}::uuid, ${ownerId}::uuid, ${botId}, ${hash(sessionId)}, ${hash(secret)}, clock_timestamp() + interval '5 minutes')
        `);
      });

      return { id, secret };
    },
    async status(ownerId: string, sessionId: string) {
      const binding = await database.execute<{ userId: string }>(sql`
        SELECT user_id::text AS "userId" FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}
      `);
      const challenge = await database.execute<{
        id: string;
        userId: string | null;
        name: string | null;
      }>(sql`
        SELECT id, candidate_id::text AS "userId", candidate_name AS name FROM winston.telegram_challenges
        WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId} AND session_hash = ${hash(sessionId)}
          AND expires_at > clock_timestamp() AND confirmed_at IS NULL
      `);

      return { binding: binding.rows[0] ?? null, challenge: challenge.rows[0] ?? null };
    },
    async confirm(ownerId: string, sessionId: string, id: string) {
      return database.transaction(async (transaction) => {
        await lockOwner(transaction, ownerId);
        const candidates = await transaction.execute<{ userId: string }>(sql`
          SELECT candidate_id::text AS "userId" FROM winston.telegram_challenges
          WHERE id = ${id}::uuid AND owner_id = ${ownerId}::uuid AND bot_id = ${botId}
            AND session_hash = ${hash(sessionId)} AND expires_at > clock_timestamp()
            AND candidate_id IS NOT NULL AND confirmed_at IS NULL FOR UPDATE
        `);
        const candidate = candidates.rows[0];
        if (!candidate) return false;

        await transaction.execute(sql`
          INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id)
          VALUES (${ownerId}::uuid, ${botId}, ${candidate.userId}::bigint, ${candidate.userId}::bigint)
          ON CONFLICT (owner_id, bot_id) DO UPDATE SET user_id = EXCLUDED.user_id, chat_id = EXCLUDED.chat_id
        `);
        await transaction.execute(
          sql`UPDATE winston.telegram_challenges SET confirmed_at = clock_timestamp() WHERE id = ${id}::uuid`,
        );

        return true;
      });
    },
    async unpair(ownerId: string) {
      await database.transaction(async (transaction) => {
        await lockOwner(transaction, ownerId);
        await transaction.execute(
          sql`DELETE FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}`,
        );
        await transaction.execute(
          sql`DELETE FROM winston.telegram_challenges WHERE owner_id = ${ownerId}::uuid AND bot_id = ${botId}`,
        );
      });
    },
    async receive(input: unknown) {
      const receivedAt = new Date();
      const update = telegramUpdateSchema.parse(input);
      const message = update.message ?? update.edited_message;
      const sender = message?.from;
      if (
        !message ||
        !sender ||
        sender.is_bot ||
        message.chat.type !== "private" ||
        message.chat.id !== sender.id
      )
        return "ignored";

      const start = update.message?.text?.match(/^\/start ([A-Za-z0-9_-]{43})$/);
      if (start?.[1]) {
        const changed = await database.execute(sql`
          UPDATE winston.telegram_challenges SET candidate_id = ${sender.id}, candidate_name = ${sender.first_name.slice(0, 128)}
          WHERE bot_id = ${botId} AND secret_hash = ${hash(start[1])} AND expires_at > clock_timestamp()
            AND candidate_id IS NULL AND confirmed_at IS NULL RETURNING id
        `);

        return changed.rowCount ? "candidate" : "ignored";
      }

      return database.transaction(async (transaction) => {
        const bindings = await transaction.execute<{ ownerId: string }>(sql`
          SELECT owner_id AS "ownerId" FROM winston.telegram_bindings
          WHERE bot_id = ${botId} AND user_id = ${sender.id} AND chat_id = ${message.chat.id}
        `);
        const ownerId = bindings.rows[0]?.ownerId;
        if (!ownerId) return "ignored";
        const owner = await lockOwner(transaction, ownerId);
        const stillBound = await transaction.execute(sql`
          SELECT 1 FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid
            AND bot_id = ${botId} AND user_id = ${sender.id} AND chat_id = ${message.chat.id}
        `);
        if (!stillBound.rowCount) return "ignored";

        const snapshot = timestampSnapshot(receivedAt, owner.timezone);
        const inserted = await transaction.execute(sql`
          INSERT INTO winston.telegram_updates (bot_id, update_id, owner_id, received_at, timezone_snapshot, payload)
          VALUES (${botId}, ${update.update_id}, ${ownerId}::uuid, ${receivedAt.toISOString()}::timestamptz,
            ${JSON.stringify(snapshot)}::jsonb, ${JSON.stringify(update)}::jsonb)
          ON CONFLICT DO NOTHING RETURNING update_id
        `);
        if (!inserted.rowCount) return "duplicate";

        await eventRepository(transaction, ownerId).publish({
          key: `${String(botId)}:${String(update.update_id)}`,
          type: update.edited_message ? "telegram.message-edited" : "telegram.message-received",
          payload: { botId, updateId: update.update_id },
          destinations: ["conversation-inbox"],
        });

        return "accepted";
      });
    },
  };
}

export type TelegramStore = ReturnType<typeof createTelegramStore>;
