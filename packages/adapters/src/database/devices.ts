import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  deviceNameSchema,
  devicePairingTokenSchema,
  deviceRegistrationSchema,
  registeredDeviceSchema,
  type DeviceRegistration,
  type RegisteredDevice,
} from "@winston/contracts/device-registry";
import type { DatabaseTransaction } from "./owners";
import { eventRepository } from "./events";

export const deviceTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

type DeviceRow = Omit<RegisteredDevice, "createdAt"> & { createdAt: string | Date };
const columns = sql`id, name, platform, app_version AS "appVersion", protocol_version AS "protocolVersion",
  capabilities, revision, is_default AS "isDefault", (revoked_at IS NOT NULL) AS revoked, created_at AS "createdAt"`;
const view = (row: DeviceRow) =>
  registeredDeviceSchema.parse({ ...row, createdAt: new Date(row.createdAt).toISOString() });

export function deviceRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lockOwner() {
    const owner = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!owner.rowCount) throw new Error("Owner profile is unavailable.");
  }

  async function find(id: string) {
    const deviceId = registeredDeviceSchema.shape.id.parse(id);
    const rows = await transaction.execute<DeviceRow>(
      sql`SELECT ${columns} FROM winston.devices WHERE owner_id = ${ownerId}::uuid AND id = ${deviceId}::uuid`,
    );
    return rows.rows[0] ? view(rows.rows[0]) : null;
  }

  return {
    find,
    async list() {
      const rows = await transaction.execute<DeviceRow>(
        sql`SELECT ${columns} FROM winston.devices WHERE owner_id = ${ownerId}::uuid ORDER BY created_at, id`,
      );
      return rows.rows.map(view);
    },
    async start(name: string) {
      const parsedName = deviceNameSchema.parse(name);
      await lockOwner();
      const id = randomUUID();
      const secret = `wdp_${randomBytes(32).toString("base64url")}`;
      // Starting another attempt explicitly replaces the owner's previous pending attempt.
      await transaction.execute(
        sql`DELETE FROM winston.device_pairing WHERE owner_id = ${ownerId}::uuid`,
      );
      const rows = await transaction.execute<{ expiresAt: string | Date }>(sql`
        INSERT INTO winston.device_pairing (owner_id, id, name, secret_hash, expires_at)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${parsedName}, ${deviceTokenHash(secret)}, clock_timestamp() + interval '5 minutes')
        RETURNING expires_at AS "expiresAt"
      `);
      const row = rows.rows[0];
      if (!row) throw new Error("Pairing challenge was not created.");
      return { id, secret, expiresAt: new Date(row.expiresAt).toISOString() };
    },
    async cancelPairing(id: string) {
      const challengeId = registeredDeviceSchema.shape.id.parse(id);
      await lockOwner();
      await transaction.execute(
        sql`DELETE FROM winston.device_pairing WHERE owner_id = ${ownerId}::uuid AND id = ${challengeId}::uuid`,
      );
    },
    async pair(secret: string, registration: DeviceRegistration) {
      const token = devicePairingTokenSchema.parse(secret);
      const input = deviceRegistrationSchema.parse(registration);
      await lockOwner();
      const rows = await transaction.execute<{ name: string }>(sql`
        DELETE FROM winston.device_pairing WHERE owner_id = ${ownerId}::uuid
          AND secret_hash = ${deviceTokenHash(token)} AND expires_at > clock_timestamp() RETURNING name
      `);
      const challenge = rows.rows[0];
      if (!challenge) return null;
      const id = randomUUID();
      const credential = `wdi_${randomBytes(32).toString("base64url")}`;
      await transaction.execute(sql`
        INSERT INTO winston.devices (owner_id, id, name, platform, app_version, protocol_version, capabilities, token_hash)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${challenge.name}, ${input.platform}, ${input.appVersion},
          ${input.protocolVersion}, ${JSON.stringify(input.capabilities)}::jsonb, ${deviceTokenHash(credential)})
      `);
      const device = await find(id);
      if (!device) throw new Error("Device registration was not created.");
      return { device, credential };
    },
    async rename(id: string, revision: number, name: string) {
      const parsedName = deviceNameSchema.parse(name);
      await lockOwner();
      const current = await find(id);
      if (!current || current.revoked || current.revision !== revision) return null;
      await transaction.execute(sql`
        UPDATE winston.devices SET name = ${parsedName}, revision = revision + 1
        WHERE owner_id = ${ownerId}::uuid AND id = ${current.id}::uuid
      `);
      return find(id);
    },
    async setDefault(id: string, revision: number) {
      await lockOwner();
      const current = await find(id);
      if (!current || current.revoked || current.revision !== revision) return null;
      if (current.isDefault) return current;
      await transaction.execute(sql`
        UPDATE winston.devices SET is_default = false, revision = revision + 1
        WHERE owner_id = ${ownerId}::uuid AND is_default
      `);
      await transaction.execute(sql`
        UPDATE winston.devices SET is_default = true, revision = revision + 1
        WHERE owner_id = ${ownerId}::uuid AND id = ${current.id}::uuid
      `);
      return find(id);
    },
    async revoke(id: string, revision: number) {
      await lockOwner();
      const current = await find(id);
      if (!current || current.revision !== revision) return null;
      if (current.revoked) return current;
      await transaction.execute(sql`
        UPDATE winston.devices
        SET token_hash = NULL, revoked_at = clock_timestamp(), is_default = false, revision = revision + 1
        WHERE owner_id = ${ownerId}::uuid AND id = ${current.id}::uuid
      `);
      await eventRepository(transaction, ownerId).publish({
        key: `${current.id}:${String(revision + 1)}`,
        type: "device.revoked",
        payload: { deviceId: current.id, revision: revision + 1 },
        destinations: ["device-runtime"],
      });
      return find(id);
    },
  };
}

export type DeviceRepository = ReturnType<typeof deviceRepository>;
