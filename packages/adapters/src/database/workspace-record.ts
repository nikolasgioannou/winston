import { sql } from "drizzle-orm";
import { registeredWorkspaceSchema, type RegisteredWorkspace } from "@winston/contracts/workspace";
import type { DatabaseTransaction } from "./owners";

export async function findWorkspace(
  transaction: DatabaseTransaction,
  ownerId: string,
  inputId: string,
  lock = false,
) {
  const id = registeredWorkspaceSchema.shape.id.parse(inputId);
  const result = await transaction.execute<RegisteredWorkspace>(sql`
    SELECT id, name, state, revision FROM winston.workspaces
    WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    ${lock ? sql`FOR SHARE` : sql``}
  `);
  return result.rows[0] ? registeredWorkspaceSchema.parse(result.rows[0]) : null;
}
