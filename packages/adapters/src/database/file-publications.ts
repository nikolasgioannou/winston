import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { filePublicationSchema, type FilePublication } from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { AuthorizationSnapshot } from "@winston/contracts/authorization";
import type { DatabaseTransaction } from "./owners";
import { capabilityRepository } from "./capabilities";
import { authorizationRepository } from "./authorization";

export function filePublicationRepository(transaction: DatabaseTransaction, ownerId: string) {
  return {
    async authorize(
      credential: ServiceRequest,
      input: FilePublication,
      expected?: AuthorizationSnapshot,
    ) {
      const request = filePublicationSchema.parse(input);
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const authority = await capabilityRepository(transaction, ownerId).authenticate(credential);
      if (authority?.operation !== "gateway:control") return { status: "denied" as const };
      const policy = await authorizationRepository(transaction, ownerId).evaluate(
        {
          operation: "workspace.file.read",
          target: { kind: "workspace", id: authority.resourceId, resource: null },
        },
        expected,
      );
      if (policy.decision !== "allow" || !policy.snapshot)
        return {
          status: policy.decision === "ask" ? ("approval_required" as const) : ("denied" as const),
        };
      const rows = await transaction.execute<{ intentRevision: number }>(sql`
        SELECT intent_revision AS "intentRevision" FROM winston.tasks
        WHERE owner_id = ${ownerId}::uuid AND id = ${authority.taskId}::uuid
      `);
      const task = rows.rows[0];
      if (!task) return { status: "denied" as const };
      return {
        status: "allowed" as const,
        snapshot: policy.snapshot,
        key: `file:${authority.taskId}:${String(task.intentRevision)}:${createHash("sha256").update(request.key).digest("hex")}`,
        metadata: {
          name: request.name,
          mediaType: request.mediaType,
          size: request.size,
          sha256: request.sha256,
          source: {
            kind: "workspace" as const,
            reference: `workspace:${authority.resourceId}/task:${authority.taskId}/intent:${String(task.intentRevision)}`,
          },
        },
      };
    },
  };
}
