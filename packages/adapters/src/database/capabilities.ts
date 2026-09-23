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
    if (scope.operation === "gateway:read" || scope.operation === "gateway:control") {
      if (
        scope.kind !== "workspace" ||
        scope.subjectId !== scope.resourceId ||
        scope.resourceRevision === undefined ||
        scope.credential !== null
      )
        return false;
      const workspace = await transaction.execute(sql`
        SELECT id FROM winston.workspaces WHERE owner_id = ${ownerId}::uuid
          AND id = ${scope.resourceId}::uuid AND revision = ${scope.resourceRevision} AND state = 'active'
      `);
      if (!workspace.rowCount) return false;
    }
    if (scope.operation === "workspace:observe" || scope.operation === "workspace:cancel") {
      if (
        scope.kind !== "worker" ||
        scope.credential !== null ||
        !scope.executionId ||
        scope.resourceRevision === undefined
      )
        return false;
      const execution = await transaction.execute(sql`
        SELECT a.id FROM winston.actions a JOIN winston.workspaces w
          ON w.owner_id = a.owner_id AND w.id = ${scope.resourceId}::uuid
        WHERE a.owner_id = ${ownerId}::uuid AND a.task_id = ${scope.taskId}::uuid
          AND a.document->>'operationId' = ${scope.executionId}
          AND a.document->>'state' IN ('dispatching', 'unknown', 'succeeded', 'failed')
          AND a.document->'request'->'authorization'->'target'->>'kind' = 'workspace'
          AND a.document->'request'->'authorization'->'target'->>'id' = ${scope.resourceId}
          AND a.document->'request'->'authorization'->>'operation' = 'workspace.command'
          AND a.document->'dispatchTask'->>'revision' = ${scope.revision}::text
          AND a.document->'dispatchTask'->>'generation' = ${scope.generation}::text
          AND w.state <> 'retired' AND w.revision = ${scope.resourceRevision}
      `);
      return execution.rowCount === 1;
    }
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
