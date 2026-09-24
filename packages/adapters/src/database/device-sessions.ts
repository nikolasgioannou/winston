import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { deviceStatusSchema } from "@winston/contracts/devices";
import {
  deviceCredentialSchema,
  deviceSessionIdentitySchema,
  deviceSessionSchema,
  devicePresenceSchema,
  type DeviceSessionIdentity,
} from "@winston/contracts/device-registry";
import type { DatabaseTransaction } from "./owners";
import { deviceTokenHash } from "./devices";
import { eventRepository } from "./events";

export function deviceSessionRepository(transaction: DatabaseTransaction, ownerId: string) {
  const events = eventRepository(transaction, ownerId);
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function close(input: DeviceSessionIdentity) {
    const session = deviceSessionIdentitySchema.parse(input);
    await lock();
    const result = await transaction.execute(sql`
      UPDATE winston.device_sessions SET disconnected_at = clock_timestamp()
      WHERE owner_id = ${ownerId}::uuid AND device_id = ${session.deviceId}::uuid
        AND session_id = ${session.sessionId}::uuid AND generation = ${session.generation}
        AND disconnected_at IS NULL
    `);
    if (!result.rowCount) return false;
    await events.publish({
      key: `${session.sessionId}:offline`,
      type: "device.offline",
      payload: session,
      destinations: ["device-runtime"],
    });
    return true;
  }
  return {
    async open(inputId: string, inputCredential: string) {
      const deviceId = deviceSessionIdentitySchema.shape.deviceId.parse(inputId);
      const credentialHash = deviceTokenHash(deviceCredentialSchema.parse(inputCredential));
      await lock();
      const rows = await transaction.execute<{
        deviceId: string;
        sessionId: string;
        generation: number;
        expiresAt: string;
      }>(sql`
        INSERT INTO winston.device_sessions (owner_id, device_id, session_id, generation, credential_hash, lease_until)
        SELECT owner_id, id, ${randomUUID()}::uuid, 1, token_hash, clock_timestamp() + interval '45 seconds'
        FROM winston.devices WHERE owner_id = ${ownerId}::uuid AND id = ${deviceId}::uuid
          AND revoked_at IS NULL AND token_hash = ${credentialHash}
        ON CONFLICT (owner_id, device_id) DO UPDATE SET
          session_id = EXCLUDED.session_id, generation = winston.device_sessions.generation + 1,
          credential_hash = EXCLUDED.credential_hash, lease_until = EXCLUDED.lease_until,
          reported_status = NULL, last_seen_at = NULL, disconnected_at = NULL, presence_revision = 0
        RETURNING device_id AS "deviceId", session_id AS "sessionId", generation::float8 AS generation,
          to_char(lease_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
      `);
      const row = rows.rows[0];
      if (!row) return null;
      const session = deviceSessionSchema.parse(row);
      await events.publish({
        key: `${session.sessionId}:opened`,
        type: "device.session-opened",
        payload: session,
        destinations: ["device-runtime"],
      });
      return session;
    },
    async heartbeat(input: DeviceSessionIdentity, inputStatus: string) {
      const session = deviceSessionIdentitySchema.parse(input);
      const status = deviceStatusSchema.parse(inputStatus);
      await lock();
      const rows = await transaction.execute<{ status: string | null; revision: number }>(sql`
        SELECT s.reported_status AS status, s.presence_revision AS revision FROM winston.device_sessions s
        JOIN winston.devices d ON d.owner_id = s.owner_id AND d.id = s.device_id
        WHERE s.owner_id = ${ownerId}::uuid AND s.device_id = ${session.deviceId}::uuid
          AND s.session_id = ${session.sessionId}::uuid AND s.generation = ${session.generation}
          AND s.disconnected_at IS NULL AND s.lease_until > clock_timestamp()
          AND d.revoked_at IS NULL AND d.token_hash = s.credential_hash
      `);
      const current = rows.rows[0];
      if (!current) return false;
      const changed = current.status !== status;
      const revision = current.revision + (changed ? 1 : 0);
      await transaction.execute(sql`
        UPDATE winston.device_sessions SET reported_status = ${status}, presence_revision = ${revision},
          last_seen_at = clock_timestamp(), lease_until = clock_timestamp() + interval '45 seconds'
        WHERE owner_id = ${ownerId}::uuid AND device_id = ${session.deviceId}::uuid
      `);
      if (changed)
        await events.publish({
          key: `${session.sessionId}:presence:${String(revision)}`,
          type: "device.presence-changed",
          payload: { ...session, status },
          destinations: ["device-runtime"],
        });
      return true;
    },
    close,
    async expire() {
      await lock();
      const rows = await transaction.execute<DeviceSessionIdentity>(sql`
        SELECT s.device_id AS "deviceId", s.session_id AS "sessionId", s.generation::float8 AS generation
        FROM winston.device_sessions s JOIN winston.devices d ON d.owner_id = s.owner_id AND d.id = s.device_id
        WHERE s.owner_id = ${ownerId}::uuid AND s.disconnected_at IS NULL
          AND (s.lease_until <= clock_timestamp() OR d.revoked_at IS NOT NULL OR d.token_hash IS DISTINCT FROM s.credential_hash)
        ORDER BY s.lease_until, s.device_id LIMIT 100
      `);
      for (const session of rows.rows) await close(session);
      return rows.rows.length;
    },
    async presence() {
      const rows = await transaction.execute<{
        deviceId: string;
        status: string;
        lastSeenAt: string | null;
      }>(sql`
        SELECT d.id AS "deviceId",
          CASE WHEN d.revoked_at IS NULL AND d.token_hash = s.credential_hash AND s.disconnected_at IS NULL
            AND s.lease_until > clock_timestamp() THEN COALESCE(s.reported_status, 'unreachable') ELSE 'unreachable' END AS status,
          to_char(s.last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastSeenAt"
        FROM winston.devices d LEFT JOIN winston.device_sessions s ON s.owner_id = d.owner_id AND s.device_id = d.id
        WHERE d.owner_id = ${ownerId}::uuid ORDER BY d.id LIMIT 1000
      `);
      return rows.rows.map((row) => devicePresenceSchema.parse(row));
    },
  };
}
