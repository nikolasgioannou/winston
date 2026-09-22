import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  connectionSchema,
  connectionStartSchema,
  type ConnectionStart,
  type Connection,
} from "@winston/contracts/connections";
import type { DatabaseTransaction } from "./owners";
import { taskRepository } from "./tasks";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Challenge = {
  id: string;
  intent: ConnectionStart;
  expectedSubject: string | null;
  expectedRevision: number | null;
};

export function connectionRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const result = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!result.rowCount) throw new Error("Owner unavailable.");
  }
  async function find(id: string) {
    const rows = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.google_connections WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    return rows.rows[0] ? connectionSchema.parse(rows.rows[0].document) : undefined;
  }
  async function currentTask(input: ConnectionStart["task"]) {
    if (!input) return undefined;
    const task = await taskRepository(transaction, ownerId).find(input.id);
    return task?.state === "waiting" &&
      task.revision === input.revision &&
      task.blocker?.kind === "connection" &&
      task.blocker.referenceId === input.blockerId
      ? input
      : undefined;
  }
  return {
    find,
    currentTask,
    async tryRefreshLock(id: string) {
      const result = await transaction.execute<{ acquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`google-refresh:${ownerId}:${id}`}, 0)) AS acquired
      `);
      return result.rows[0]?.acquired === true;
    },
    async setHealth(id: string, revision: number, status: Connection["status"], scopes?: string[]) {
      await lock();
      const current = await find(id);
      if (!current || current.revision !== revision) throw new Error("Connection changed.");
      const updated = connectionSchema.parse({
        ...current,
        revision: revision + 1,
        status,
        scopes: scopes ?? current.scopes,
      });
      await transaction.execute(sql`
        UPDATE winston.google_connections SET document = ${JSON.stringify(updated)}::jsonb
        WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);
      return updated;
    },
    async selectCalendars(id: string, revision: number, calendars: string[]) {
      await lock();
      const current = await find(id);
      if (!current || current.service !== "calendar" || current.revision !== revision)
        throw new Error("Connection changed.");
      const updated = connectionSchema.parse({
        ...current,
        revision: revision + 1,
        calendars: [...new Set(calendars)],
      });
      await transaction.execute(
        sql`UPDATE winston.google_connections SET document = ${JSON.stringify(updated)}::jsonb WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid`,
      );
      return updated;
    },
    async list() {
      const rows = await transaction.execute<{ document: unknown }>(
        sql`SELECT document FROM winston.google_connections WHERE owner_id = ${ownerId}::uuid ORDER BY service, subject`,
      );
      return rows.rows.map((row) => connectionSchema.parse(row.document));
    },
    async bySubject(subject: string, service: Connection["service"]) {
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.google_connections WHERE owner_id = ${ownerId}::uuid AND subject = ${subject} AND service = ${service}
      `);
      return rows.rows[0] ? connectionSchema.parse(rows.rows[0].document) : undefined;
    },
    async start(sessionId: string, input: ConnectionStart) {
      const intent = connectionStartSchema.parse(input);
      await lock();
      const current = intent.connectionId ? await find(intent.connectionId) : undefined;
      if (intent.connectionId && (!current || current.service !== intent.service))
        throw new Error("Connection unavailable.");
      if (intent.task && !(await currentTask(intent.task)))
        throw new Error("Waiting task changed.");
      const state = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await transaction.execute(sql`
        DELETE FROM winston.google_challenges WHERE owner_id = ${ownerId}::uuid
          AND (expires_at < clock_timestamp() OR (session_hash = ${hash(sessionId)} AND completed_at IS NULL))
      `);
      await transaction.execute(sql`
        INSERT INTO winston.google_challenges (owner_id, id, state_hash, session_hash, intent, expected_subject, expected_revision, expires_at)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${hash(state)}, ${hash(sessionId)}, ${JSON.stringify(intent)}::jsonb,
          ${current?.subject ?? null}, ${current?.revision ?? null}, clock_timestamp() + interval '10 minutes')
      `);
      return state;
    },
    async claim(sessionId: string, state: string): Promise<Challenge | undefined> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return undefined;
      const rows = await transaction.execute<{
        id: string;
        intent: unknown;
        expectedSubject: string | null;
        expectedRevision: number | null;
      }>(sql`
        UPDATE winston.google_challenges SET consumed_at = clock_timestamp()
        WHERE owner_id = ${ownerId}::uuid AND state_hash = ${hash(state)} AND session_hash = ${hash(sessionId)}
          AND consumed_at IS NULL AND expires_at > clock_timestamp()
        RETURNING id, intent, expected_subject AS "expectedSubject", expected_revision AS "expectedRevision"
      `);
      const row = rows.rows[0];
      return row ? { ...row, intent: connectionStartSchema.parse(row.intent) } : undefined;
    },
    async complete(challenge: Challenge, connection: Connection) {
      await lock();
      const parsed = connectionSchema.parse(connection);
      const current = await find(parsed.id);
      if (
        (current?.revision ?? null) !== challenge.expectedRevision ||
        (challenge.expectedSubject !== null && parsed.subject !== challenge.expectedSubject) ||
        (challenge.intent.connectionId !== undefined &&
          parsed.id !== challenge.intent.connectionId) ||
        parsed.service !== challenge.intent.service
      )
        throw new Error("Connection changed during authorization.");
      const result = await transaction.execute(sql`
        UPDATE winston.google_challenges SET completed_at = clock_timestamp()
        WHERE owner_id = ${ownerId}::uuid AND id = ${challenge.id}::uuid AND consumed_at IS NOT NULL
          AND completed_at IS NULL AND expires_at > clock_timestamp() RETURNING id
      `);
      if (!result.rowCount) throw new Error("Connection attempt expired or already completed.");
      await transaction.execute(sql`
        INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${parsed.id}::uuid, ${parsed.subject}, ${parsed.service}, ${JSON.stringify(parsed)}::jsonb)
        ON CONFLICT (owner_id, id) DO UPDATE SET document = EXCLUDED.document
      `);
    },
  };
}
export type ConnectionRepository = ReturnType<typeof connectionRepository>;
