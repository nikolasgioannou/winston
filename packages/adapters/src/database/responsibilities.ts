import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@winston/contracts/json";
import {
  responsibilityProposalSchema,
  responsibilitySchema,
  type Responsibility,
  type ResponsibilityProposal,
} from "@winston/contracts/responsibilities";
import { userMessageSchema } from "@winston/contracts/messages";
import type { DatabaseTransaction } from "./owners";
import { authorizationResource } from "./authorization-resources";
import { scheduleRepository } from "./schedules";
import { scheduleSchema } from "@winston/contracts/schedules";

export class ResponsibilityWriteError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid_scope") {
    super(`Responsibility ${kind}.`);
  }
}

export function responsibilityRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
  }
  async function find(id: string) {
    responsibilitySchema.shape.id.parse(id);
    const result = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.responsibilities WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
    `);
    return result.rows[0] ? responsibilitySchema.parse(result.rows[0].document) : undefined;
  }
  async function clock() {
    const result = await transaction.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const now = result.rows[0]?.now;
    if (!now) throw new Error("Database clock is unavailable.");
    return new Date(now).toISOString();
  }
  async function validate(input: ResponsibilityProposal) {
    const parsed = responsibilityProposalSchema.parse(input);
    parsed.sourceMessageIds = [...new Set(parsed.sourceMessageIds)].sort();
    parsed.scope = [...new Map(parsed.scope.map((item) => [canonicalJson(item), item])).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item);
    for (const target of parsed.scope) {
      if ((await authorizationResource(transaction, ownerId, target, false)) === null)
        throw new ResponsibilityWriteError("invalid_scope");
    }
    const sources: Responsibility["sources"] = [];
    for (const id of parsed.sourceMessageIds) {
      const result = await transaction.execute<{ envelope: unknown }>(sql`
        SELECT envelope FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid
      `);
      if (!result.rows[0]) throw new ResponsibilityWriteError("invalid_scope");
      const message = userMessageSchema.parse(result.rows[0].envelope);
      sources.push({ messageId: id, revision: message.revision });
    }
    return { parsed, sources };
  }
  async function record(input: Responsibility) {
    const value = responsibilitySchema.parse(input);
    await transaction.execute(sql`
      UPDATE winston.responsibilities SET document = ${JSON.stringify(value)}::jsonb
      WHERE owner_id = ${ownerId}::uuid AND id = ${value.id}::uuid
    `);
    await transaction.execute(sql`
      INSERT INTO winston.responsibility_history (owner_id, responsibility_id, revision, document)
      VALUES (${ownerId}::uuid, ${value.id}::uuid, ${value.revision}, ${JSON.stringify(value)}::jsonb)
    `);
    return value;
  }
  async function suspendSchedules(id: string, pause: boolean) {
    const result = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.schedules WHERE owner_id = ${ownerId}::uuid
        AND document->'responsibility'->>'id' = ${id} AND document->>'state' <> 'canceled'
    `);
    const schedules = scheduleRepository(transaction, ownerId);
    for (const row of result.rows) {
      const schedule = scheduleSchema.parse(row.document);
      if (pause && schedule.state === "paused") continue;
      if (pause && schedule.state === "active")
        await schedules.pause(schedule.id, schedule.revision);
      else await schedules.cancel(schedule.id, schedule.revision);
    }
  }
  async function current(id: string, revision: number) {
    responsibilitySchema.shape.revision.parse(revision);
    await lock();
    const value = await find(id);
    if (!value) throw new ResponsibilityWriteError("not_found");
    if (value.revision !== revision || value.state === "ended")
      throw new ResponsibilityWriteError("conflict");
    return value;
  }
  return {
    find,
    async list(after?: string) {
      if (after) responsibilitySchema.shape.id.parse(after);
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.responsibilities WHERE owner_id = ${ownerId}::uuid
          AND (${after ?? null}::uuid IS NULL OR id > ${after ?? null}::uuid) ORDER BY id LIMIT 100
      `);
      return result.rows.map((row) => responsibilitySchema.parse(row.document));
    },
    async propose(input: ResponsibilityProposal) {
      await lock();
      const { parsed, sources } = await validate(input);
      const hash = createHash("sha256").update(canonicalJson(parsed)).digest("hex");
      const previous = await transaction.execute<{ document: unknown; hash: string }>(sql`
        SELECT document, request_hash AS hash FROM winston.responsibilities
        WHERE owner_id = ${ownerId}::uuid AND request_key = ${parsed.key}
      `);
      if (previous.rows[0]) {
        if (previous.rows[0].hash !== hash) throw new ResponsibilityWriteError("conflict");
        return responsibilitySchema.parse(previous.rows[0].document);
      }
      const now = await clock();
      const value: Responsibility = {
        id: randomUUID(),
        ownerId,
        revision: 0,
        state: "proposed",
        purpose: parsed.purpose,
        scope: parsed.scope,
        sources,
        agreement: null,
        createdAt: now,
        updatedAt: now,
      };
      await transaction.execute(sql`
        INSERT INTO winston.responsibilities (owner_id, id, request_key, request_hash, document)
        VALUES (${ownerId}::uuid, ${value.id}::uuid, ${parsed.key}, ${hash}, ${JSON.stringify(value)}::jsonb)
      `);
      return record(value);
    },
    async revise(id: string, revision: number, input: Omit<ResponsibilityProposal, "key">) {
      const value = await current(id, revision);
      const { parsed, sources } = await validate({ ...input, key: "revision" });
      await suspendSchedules(id, false);
      return record({
        ...value,
        purpose: parsed.purpose,
        scope: parsed.scope,
        sources,
        revision: revision + 1,
        state: "proposed",
        agreement: null,
        updatedAt: await clock(),
      });
    },
    // Call only after explicit authenticated owner agreement, never from a worker proposal.
    async agree(id: string, revision: number) {
      const value = await current(id, revision);
      if (value.state !== "proposed") throw new ResponsibilityWriteError("conflict");
      const validated = await validate({
        key: "agreement",
        purpose: value.purpose,
        scope: value.scope,
        sourceMessageIds: value.sources.map((source) => source.messageId),
      });
      if (canonicalJson(validated.sources) !== canonicalJson(value.sources))
        throw new ResponsibilityWriteError("conflict");
      const now = await clock();
      return record({
        ...value,
        revision: revision + 1,
        state: "active",
        updatedAt: now,
        agreement: { proposalRevision: revision, at: now },
      });
    },
    async transition(id: string, revision: number, state: "active" | "paused" | "ended") {
      const value = await current(id, revision);
      if (
        (state === "active" && (value.state !== "paused" || !value.agreement)) ||
        (state === "paused" && value.state !== "active")
      )
        throw new ResponsibilityWriteError("conflict");
      if (state !== "active") await suspendSchedules(id, state === "paused");
      return record({ ...value, revision: revision + 1, state, updatedAt: await clock() });
    },
  };
}
