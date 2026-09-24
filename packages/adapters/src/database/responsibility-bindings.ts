import { sql } from "drizzle-orm";
import { responsibilitySchema } from "@winston/contracts/responsibilities";
import { scheduleResponsibilitySchema } from "@winston/contracts/schedules";
import type { Schedule } from "@winston/contracts/schedules";
import type { AuthorizationRequest } from "@winston/contracts/authorization";
import { canonicalJson } from "@winston/contracts/json";
import type { DatabaseTransaction } from "./owners";

export async function responsibilityBindingAllowed(
  transaction: DatabaseTransaction,
  ownerId: string,
  binding: NonNullable<Schedule["responsibility"]>,
  request?: AuthorizationRequest,
) {
  const parsed = scheduleResponsibilitySchema.parse(binding);
  const result = await transaction.execute<{ document: unknown }>(sql`
    SELECT r.document FROM winston.responsibilities r
    WHERE r.owner_id = ${ownerId}::uuid AND r.id = ${parsed.id}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.document->'sources') source
        LEFT JOIN winston.conversation_messages m ON m.owner_id = r.owner_id
          AND m.id = (source->>'messageId')::uuid
        WHERE m.id IS NULL OR (m.envelope->>'revision')::integer <> (source->>'revision')::integer
      )
  `);
  if (!result.rows[0]) return false;
  const responsibility = responsibilitySchema.parse(result.rows[0].document);
  return (
    responsibility.state === "active" &&
    responsibility.agreement?.proposalRevision === parsed.agreementRevision &&
    (!request ||
      responsibility.scope.some((item) => canonicalJson(item) === canonicalJson(request)))
  );
}

export async function taskResponsibilityBinding(
  transaction: DatabaseTransaction,
  ownerId: string,
  taskId: string,
) {
  const result = await transaction.execute<{ binding: unknown }>(sql`
    SELECT s.document->'responsibility' AS binding FROM winston.schedule_occurrences o
    JOIN winston.schedules s ON s.owner_id = o.owner_id AND s.id = o.schedule_id
    WHERE o.owner_id = ${ownerId}::uuid AND o.task_id = ${taskId}::uuid
  `);
  const binding = result.rows[0]?.binding;
  return binding ? scheduleResponsibilitySchema.parse(binding) : undefined;
}

export async function responsibilityTaskAllowed(
  transaction: DatabaseTransaction,
  ownerId: string,
  taskId: string,
  request?: AuthorizationRequest,
) {
  const binding = await taskResponsibilityBinding(transaction, ownerId, taskId);
  if (binding) return responsibilityBindingAllowed(transaction, ownerId, binding, request);
  const setup = await taskResponsibilitySetup(transaction, ownerId, taskId);
  if (!setup) return true;
  return (
    !!setup.agreement &&
    responsibilityBindingAllowed(
      transaction,
      ownerId,
      {
        id: setup.id,
        agreementRevision: setup.agreement.proposalRevision,
      },
      request,
    )
  );
}

export async function taskResponsibilitySetup(
  transaction: DatabaseTransaction,
  ownerId: string,
  taskId: string,
) {
  const result = await transaction.execute<{ document: unknown }>(sql`
    SELECT r.document FROM winston.responsibility_requests q
    JOIN winston.tasks t ON t.owner_id = q.owner_id AND t.id = q.task_id AND t.intent_revision = q.intent_revision
    JOIN winston.responsibilities r ON r.owner_id = q.owner_id AND r.id = q.responsibility_id
    WHERE q.owner_id = ${ownerId}::uuid AND q.task_id = ${taskId}::uuid
  `);
  return result.rows[0] ? responsibilitySchema.parse(result.rows[0].document) : undefined;
}
