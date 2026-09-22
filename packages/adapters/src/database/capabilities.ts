import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  serviceRequestSchema,
  serviceScopeSchema,
  type ServiceRequest,
  type ServiceScope,
} from "@winston/contracts/capabilities";
import type { DatabaseTransaction } from "./owners";

export function capabilityHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function capabilityRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function live(scope: ServiceScope) {
    const task = await transaction.execute(sql`
      SELECT id FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${scope.taskId}::uuid
        AND document->>'state' = 'running' AND (document->>'revision')::integer = ${scope.revision}
        AND (document->>'generation')::integer = ${scope.generation} AND leased_until > clock_timestamp()
    `);
    if (!task.rowCount) return false;
    if (scope.credential) {
      const credential = await transaction.execute(sql`
        SELECT id FROM winston.credentials WHERE owner_id = ${ownerId}::uuid AND id = ${scope.credential.id}::uuid
          AND revision = ${scope.credential.revision} AND encrypted IS NOT NULL
      `);
      if (!credential.rowCount) return false;
    }
    return true;
  }

  return {
    // Trusted broker only, after resource ownership and permission policy are checked.
    // This primitive is deliberately absent from model tools and owner/device HTTP routes.
    async issue(input: ServiceScope, lifetimeSeconds = 60) {
      const scope = serviceScopeSchema.parse(input);
      if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300)
        throw new Error("Invalid capability lifetime.");
      if (!(await live(scope))) throw new Error("Task or credential is no longer current.");
      const id = randomUUID();
      const token = `wst_${randomBytes(32).toString("base64url")}`;
      await transaction.execute(sql`
        INSERT INTO winston.service_capabilities (owner_id, id, token_hash, document, expires_at)
        VALUES (${ownerId}::uuid, ${id}::uuid, ${capabilityHash(token)}, ${JSON.stringify(scope)}::jsonb,
          clock_timestamp() + ${lifetimeSeconds} * interval '1 second')
      `);
      return { id, token };
    },
    async authenticate(input: ServiceRequest) {
      const parsed = serviceRequestSchema.safeParse(input);
      if (!parsed.success) return null;
      const request = parsed.data;
      const rows = await transaction.execute<{ id: string; document: unknown }>(sql`
        SELECT id, document FROM winston.service_capabilities WHERE owner_id = ${ownerId}::uuid
          AND token_hash = ${capabilityHash(request.token)} AND revoked_at IS NULL AND expires_at > clock_timestamp()
      `);
      const row = rows.rows[0];
      if (!row) return null;
      const scope = serviceScopeSchema.parse(row.document);
      if (
        scope.kind !== request.kind ||
        scope.subjectId !== request.subjectId ||
        scope.operation !== request.operation ||
        scope.resourceId !== request.resourceId ||
        !(await live(scope))
      )
        return null;
      return { ...scope, ownerId, capabilityId: row.id };
    },
    async revoke(id: string) {
      await transaction.execute(sql`
        UPDATE winston.service_capabilities SET revoked_at = COALESCE(revoked_at, clock_timestamp())
        WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);
    },
  };
}

export type CapabilityRepository = ReturnType<typeof capabilityRepository>;
