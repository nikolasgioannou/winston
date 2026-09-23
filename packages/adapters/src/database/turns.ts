import { sql } from "drizzle-orm";
import {
  turnRoundSchema,
  turnValueSchema,
  type TurnRound,
  type TurnValue,
} from "@winston/contracts/turns";
import type { DatabaseTransaction } from "./owners";
import { taskUpdateSchema } from "@winston/contracts/task-updates";

export function turnRepository(transaction: DatabaseTransaction, ownerId: string) {
  return {
    async begin(revision: number, anchorId: string) {
      await transaction.execute(sql`
        INSERT INTO winston.conversation_turns (owner_id, revision, anchor_id)
        VALUES (${ownerId}::uuid, ${revision}, ${anchorId}::uuid) ON CONFLICT DO NOTHING
      `);
    },
    async round(revision: number, step: number) {
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.conversation_rounds WHERE owner_id = ${ownerId}::uuid AND revision = ${revision} AND step = ${step}
      `);

      return rows.rows[0] ? turnRoundSchema.parse(rows.rows[0].document) : undefined;
    },
    async saveRound(revision: number, step: number, input: TurnRound) {
      const round = turnRoundSchema.parse(input);
      await transaction.execute(sql`
        INSERT INTO winston.conversation_rounds (owner_id, revision, step, document)
        VALUES (${ownerId}::uuid, ${revision}, ${step}, ${JSON.stringify(round)}::jsonb) ON CONFLICT DO NOTHING
      `);
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.conversation_rounds WHERE owner_id = ${ownerId}::uuid AND revision = ${revision} AND step = ${step}
      `);

      return turnRoundSchema.parse(result.rows[0]?.document);
    },
    async toolResult(revision: number, step: number, callId: string) {
      const rows = await transaction.execute<{ result: unknown }>(sql`
        SELECT result FROM winston.conversation_tool_results WHERE owner_id = ${ownerId}::uuid
          AND revision = ${revision} AND step = ${step} AND call_id = ${callId}
      `);

      return rows.rows[0] ? { value: turnValueSchema.parse(rows.rows[0].result) } : undefined;
    },
    async saveToolResult(revision: number, step: number, callId: string, result: TurnValue) {
      await transaction.execute(sql`
        INSERT INTO winston.conversation_tool_results (owner_id, revision, step, call_id, result)
        VALUES (${ownerId}::uuid, ${revision}, ${step}, ${callId}, ${JSON.stringify(turnValueSchema.parse(result))}::jsonb)
      `);
    },
    async finish(revision: number, responseId: string) {
      await transaction.execute(sql`
        UPDATE winston.conversation_turns SET response_id = ${responseId}::uuid WHERE owner_id = ${ownerId}::uuid AND revision = ${revision}
      `);
    },
    async history(anchorIds: string[]) {
      const rows = await transaction.execute<{
        revision: number;
        anchorId: string;
        parts: string[];
        updates: unknown[];
      }>(sql`
        SELECT t.revision, t.anchor_id AS "anchorId", o.parts,
          COALESCE((SELECT jsonb_agg(u.document ORDER BY u.created_at, u.event_id)
            FROM winston.task_updates u WHERE u.owner_id = t.owner_id AND u.response_id = t.response_id), '[]'::jsonb) AS updates
        FROM winston.conversation_turns t
        JOIN winston.telegram_outbound o ON o.owner_id = t.owner_id AND o.id = t.response_id AND o.state = 'delivered'
        WHERE t.owner_id = ${ownerId}::uuid AND t.anchor_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(anchorIds)}::jsonb)::uuid)
        ORDER BY t.revision DESC LIMIT 1000
      `);

      const steps = await transaction.execute<{
        revision: number;
        step: number;
        document: unknown;
        results: Record<string, unknown>;
      }>(sql`
        SELECT r.revision, r.step, r.document,
          COALESCE((SELECT jsonb_object_agg(v.call_id, v.result) FROM winston.conversation_tool_results v
            WHERE v.owner_id = r.owner_id AND v.revision = r.revision AND v.step = r.step), '{}'::jsonb) AS results
        FROM winston.conversation_rounds r WHERE r.owner_id = ${ownerId}::uuid
          AND r.revision IN (SELECT jsonb_array_elements_text(${JSON.stringify(rows.rows.map((row) => row.revision))}::jsonb)::integer)
        ORDER BY r.revision, r.step
      `);

      return rows.rows.reverse().map((row) => ({
        ...row,
        updates: row.updates.map((update) => taskUpdateSchema.parse(update)),
        steps: steps.rows
          .filter((step) => step.revision === row.revision)
          .map((step) => ({
            round: turnRoundSchema.parse(step.document),
            results: Object.fromEntries(
              Object.entries(step.results).map(([id, value]) => [id, turnValueSchema.parse(value)]),
            ),
          })),
      }));
    },
  };
}

export type TurnRepository = ReturnType<typeof turnRepository>;
