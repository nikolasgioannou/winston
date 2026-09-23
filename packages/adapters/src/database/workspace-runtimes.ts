import { sql } from "drizzle-orm";
import {
  workspaceRuntimeSchema,
  type WorkspaceRuntime,
} from "@winston/contracts/workspace-runtime";
import { registeredWorkspaceSchema } from "@winston/contracts/workspace";
import type { DatabaseTransaction } from "./owners";
import { findWorkspace } from "./workspace-record";
import { eventRepository } from "./events";

export function workspaceRuntimeRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function origin(workspaceId: string) {
    const rows = await transaction.execute<{ origin: string }>(sql`
      SELECT origin FROM winston.workspace_runtimes
      WHERE owner_id = ${ownerId}::uuid AND workspace_id = ${workspaceId}::uuid
    `);
    return rows.rows[0]?.origin;
  }
  return {
    // Provisioning-only: no owner endpoint, CLI command, or model tool exposes this mutation.
    async configure(input: WorkspaceRuntime) {
      const request = workspaceRuntimeSchema.parse(input);
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const workspace = await findWorkspace(transaction, ownerId, request.workspaceId, true);
      if (!workspace || workspace.state === "retired" || workspace.revision !== request.revision)
        throw new Error("Workspace is unavailable or changed.");
      if ((await origin(workspace.id)) === request.origin) return request;
      await transaction.execute(sql`
        INSERT INTO winston.workspace_runtimes (owner_id, workspace_id, origin)
        VALUES (${ownerId}::uuid, ${workspace.id}::uuid, ${request.origin})
        ON CONFLICT (owner_id, workspace_id) DO UPDATE SET origin = EXCLUDED.origin
      `);
      const revision = workspace.revision + 1;
      await transaction.execute(sql`
        UPDATE winston.workspaces SET revision = ${revision}
        WHERE owner_id = ${ownerId}::uuid AND id = ${workspace.id}::uuid
      `);
      await eventRepository(transaction, ownerId).publish({
        key: `${workspace.id}:${String(revision)}`,
        type: "workspace.changed",
        payload: { workspaceId: workspace.id, state: workspace.state, revision },
        destinations: ["task-runtime"],
      });
      return { ...request, revision };
    },
    async resolve(inputId: string) {
      const workspaceId = registeredWorkspaceSchema.shape.id.parse(inputId);
      // Callers resolve a destination and issue its capability in this same transaction.
      await transaction.execute(
        sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
      );
      const rows = await transaction.execute<{
        workspaceId: string;
        revision: number;
        origin: string;
      }>(sql`
        SELECT w.id AS "workspaceId", w.revision, r.origin FROM winston.workspaces w
        JOIN winston.workspace_runtimes r ON r.owner_id = w.owner_id AND r.workspace_id = w.id
        WHERE w.owner_id = ${ownerId}::uuid AND w.id = ${workspaceId}::uuid AND w.state = 'active'
      `);
      return rows.rows[0] ? workspaceRuntimeSchema.parse(rows.rows[0]) : null;
    },
  };
}
