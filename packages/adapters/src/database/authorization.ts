import { sql } from "drizzle-orm";
import {
  authorizationRequestSchema,
  authorizationRuleSchema,
  authorizationSnapshotSchema,
  authorizationUpdateSchema,
  type AuthorizationEvaluation,
  type AuthorizationRequest,
  type AuthorizationSnapshot,
  type AuthorizationUpdate,
} from "@winston/contracts/authorization";
import type { DatabaseTransaction } from "./owners";
import { authorizationResource, broadDeviceAuthority } from "./authorization-resources";
import { eventRepository } from "./events";

export function authorizationRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const owner = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!owner.rowCount) throw new Error("Owner unavailable.");
  }

  async function revision() {
    const rows = await transaction.execute<{ revision: number }>(
      sql`SELECT revision FROM winston.authorization_state WHERE owner_id = ${ownerId}::uuid`,
    );
    return rows.rows[0]?.revision ?? 0;
  }

  async function rule(request: AuthorizationRequest, resource: string | null) {
    const rows = await transaction.execute<{ decision: "allow" | "ask" | "deny" }>(sql`
      SELECT decision FROM winston.authorization_rules WHERE owner_id = ${ownerId}::uuid
        AND kind = ${request.target.kind} AND target_id = ${request.target.id}::uuid
        AND resource_key = ${resource ?? ""} AND operation = ${request.operation}
    `);
    return rows.rows[0]?.decision;
  }

  // Dispatch must supply the prior snapshot and separately validate the concrete action approval.
  // This policy check is not an execution token or proof of approval for arbitrary arguments.
  async function evaluate(
    input: unknown,
    expected?: AuthorizationSnapshot,
  ): Promise<AuthorizationEvaluation> {
    await lock();
    const currentRevision = await revision();
    const parsed = authorizationRequestSchema.safeParse(input);
    const denied: AuthorizationEvaluation = {
      decision: "deny",
      reason: "unsupported",
      revision: currentRevision,
      resourceRevision: null,
      broadAuthority: false,
      snapshot: null,
    };
    if (!parsed.success) return denied;
    const request = parsed.data;
    const resourceRevision = await authorizationResource(transaction, ownerId, request);
    const base = {
      ...denied,
      resourceRevision,
      broadAuthority: broadDeviceAuthority(request.operation),
      snapshot:
        resourceRevision === null
          ? null
          : { ...request, revision: currentRevision, resourceRevision },
    };
    if (resourceRevision === null) return { ...base, reason: "unavailable" };
    // An account-wide calendar rule can be configured, but executing an event action needs a calendar.
    if (
      ["calendar.read", "calendar.write"].includes(request.operation) &&
      request.target.resource === null
    )
      return { ...base, reason: "unsupported" };
    if (expected) {
      const snapshot = authorizationSnapshotSchema.safeParse(expected);
      if (
        !snapshot.success ||
        snapshot.data.revision !== currentRevision ||
        snapshot.data.resourceRevision !== resourceRevision ||
        snapshot.data.operation !== request.operation ||
        snapshot.data.target.kind !== request.target.kind ||
        snapshot.data.target.id !== request.target.id ||
        snapshot.data.target.resource !== request.target.resource
      )
        return { ...base, reason: "stale" };
    }

    const parent = await rule(request, null);
    const exact =
      request.target.resource === null ? parent : await rule(request, request.target.resource);
    // A resource exception cannot bypass a deny on its enclosing account.
    const decision = parent === "deny" ? "deny" : (exact ?? parent ?? "ask");
    return { ...base, decision, reason: exact || parent ? "rule" : "confirmation_required" };
  }

  return {
    evaluate,
    async list() {
      await lock();
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT jsonb_build_object('target', jsonb_build_object('kind', kind, 'id', target_id, 'resource', NULLIF(resource_key, '')),
          'operation', operation, 'decision', decision) AS document
        FROM winston.authorization_rules WHERE owner_id = ${ownerId}::uuid
        ORDER BY kind, target_id, resource_key, operation
      `);
      return {
        revision: await revision(),
        rules: rows.rows.map((row) => authorizationRuleSchema.parse(row.document)),
      };
    },
    // Only an authenticated owner route may call this method. It is not a model or device tool.
    async put(input: AuthorizationUpdate) {
      const update = authorizationUpdateSchema.parse(input);
      await lock();
      if ((await revision()) !== update.revision) return null;
      if (
        (await authorizationResource(transaction, ownerId, update, update.decision === "allow")) ===
        null
      )
        return null;
      const next = update.revision + 1;
      await transaction.execute(sql`
        INSERT INTO winston.authorization_rules (owner_id, kind, target_id, resource_key, operation, decision)
        VALUES (${ownerId}::uuid, ${update.target.kind}, ${update.target.id}::uuid, ${update.target.resource ?? ""}, ${update.operation}, ${update.decision})
        ON CONFLICT (owner_id, kind, target_id, resource_key, operation) DO UPDATE SET decision = EXCLUDED.decision
      `);
      await transaction.execute(sql`
        INSERT INTO winston.authorization_state (owner_id, revision) VALUES (${ownerId}::uuid, ${next})
        ON CONFLICT (owner_id) DO UPDATE SET revision = EXCLUDED.revision
      `);
      await eventRepository(transaction, ownerId).publish({
        key: `authorization:${String(next)}`,
        type: "authorization.changed",
        payload: { revision: next },
        destinations: ["action-runtime"],
      });
      return { revision: next };
    },
  };
}

export type AuthorizationRepository = ReturnType<typeof authorizationRepository>;
