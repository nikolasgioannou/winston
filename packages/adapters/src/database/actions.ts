import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  actionDecisionSchema,
  actionOutcomeSchema,
  actionRecordSchema,
  actionRequestSchema,
  actionTaskSchema,
  type ActionDecision,
  type ActionOutcome,
  type ActionRecord,
  type ActionRequest,
  type ActionTask,
} from "@winston/contracts/actions";
import { taskSchema } from "@winston/contracts/tasks";
import type { DatabaseTransaction } from "./owners";
import { authorizationRepository } from "./authorization";
import { eventRepository } from "./events";
import { taskResourceRepository } from "./task-resources";
import { canonicalJson as canonical } from "@winston/contracts/json";
import { commandInputSchema } from "@winston/contracts/commands";
import { workspaceOperationSchema, type WorkspaceOperation } from "@winston/contracts/workspace";
import {
  workspaceCommandSchema,
  type WorkspaceCommand,
} from "@winston/contracts/workspace-commands";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Row = {
  document: unknown;
  valid: boolean;
  tokenHash: string | null;
  cancellationRequested: boolean;
};

export function actionRepository(transaction: DatabaseTransaction, ownerId: string) {
  async function lock() {
    const result = await transaction.execute(
      sql`SELECT id FROM winston.owners WHERE id = ${ownerId}::uuid FOR UPDATE`,
    );
    if (!result.rowCount) throw new Error("Owner unavailable.");
  }
  async function row(inputId: string) {
    const id = actionRecordSchema.shape.id.parse(inputId);
    const result = await transaction.execute<Row>(sql`
      SELECT document, expires_at > clock_timestamp() AS valid, dispatch_token_hash AS "tokenHash",
        cancellation_requested AS "cancellationRequested"
      FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid FOR UPDATE
    `);
    return result.rows[0];
  }
  async function task(id: string) {
    const result = await transaction.execute<{
      document: unknown;
      intentRevision: number;
      leased: boolean;
    }>(sql`
      SELECT document, intent_revision AS "intentRevision", COALESCE(leased_until > clock_timestamp(), false) AS leased
      FROM winston.tasks WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid FOR UPDATE
    `);
    const value = result.rows[0];
    return value ? { ...value, task: taskSchema.parse(value.document) } : null;
  }
  async function policy(action: ActionRecord) {
    // A direct credential revocation also has to wait for the dispatch transaction.
    if (action.request.authorization.target.kind === "connection") {
      await transaction.execute(
        sql`SELECT id FROM winston.credentials WHERE owner_id = ${ownerId}::uuid AND id = ${action.request.authorization.target.id}::uuid FOR SHARE`,
      );
    }
    const evaluation = await authorizationRepository(transaction, ownerId).evaluate(
      action.request.authorization,
      action.snapshot ?? undefined,
    );
    if (
      action.request.bindingKey &&
      !(await taskResourceRepository(transaction, ownerId).matches(
        action.request.task.id,
        action.intentRevision,
        action.request.bindingKey,
        action.request.authorization,
      ))
    )
      return { ...evaluation, decision: "deny" as const, reason: "stale" as const };
    return evaluation;
  }
  async function publish(action: ActionRecord) {
    await eventRepository(transaction, ownerId).publish({
      key: `${action.id}:${String(action.revision)}`,
      type: "action.changed",
      payload: { actionId: action.id, state: action.state, revision: action.revision },
      destinations: ["action-runtime"],
    });
  }
  async function save(
    action: ActionRecord,
    change: Partial<Pick<ActionRecord, "state" | "decisionSource" | "dispatchTask" | "outcome">>,
  ) {
    const next = actionRecordSchema.parse({ ...action, ...change, revision: action.revision + 1 });
    await transaction.execute(
      sql`UPDATE winston.actions SET document = ${JSON.stringify(next)}::jsonb WHERE owner_id = ${ownerId}::uuid AND id = ${action.id}::uuid`,
    );
    await publish(next);
    return next;
  }
  function running(current: Awaited<ReturnType<typeof task>>, expected: ActionTask) {
    return (
      current?.task.id === expected.id &&
      current.task.revision === expected.revision &&
      current.task.generation === expected.generation &&
      current.task.state === "running" &&
      current.leased
    );
  }
  function sameIntent(current: Awaited<ReturnType<typeof task>>, action: ActionRecord) {
    return (
      current &&
      current.intentRevision === action.intentRevision &&
      !["succeeded", "failed", "canceled"].includes(current.task.state)
    );
  }

  function matchesExecution(action: ActionRecord, operation: WorkspaceOperation) {
    const command = commandInputSchema.safeParse(action.request.arguments);
    return (
      command.success &&
      operation.kind === "command:execute" &&
      operation.identity.ownerId === ownerId &&
      action.operationId === operation.operationId &&
      action.request.authorization.target.kind === "workspace" &&
      action.request.authorization.target.id === operation.identity.workspaceId &&
      action.request.authorization.target.resource === null &&
      action.request.authorization.operation === "workspace.command" &&
      action.dispatchTask?.id === operation.taskId &&
      action.dispatchTask.revision === operation.revision &&
      action.dispatchTask.generation === operation.generation &&
      hash(canonical(command.data)) === operation.inputHash
    );
  }

  return {
    // Trusted workspace adapter only: the caller must verify the complete returned operation.
    // This records evidence and never grants permission to dispatch or repeat an effect.
    async reconcileWorkspace(input: WorkspaceOperation, value: ActionOutcome) {
      const operation = workspaceOperationSchema.parse(input);
      const outcome = actionOutcomeSchema.parse(value);
      if (outcome.state === "unknown" || outcome.providerReference !== operation.operationId)
        return null;
      await lock();
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid
          AND document->>'operationId' = ${operation.operationId} FOR UPDATE
      `);
      if (!rows.rows[0]) return null;
      const action = actionRecordSchema.parse(rows.rows[0].document);
      if (!matchesExecution(action, operation)) return null;
      if (action.outcome && canonical(action.outcome) === canonical(outcome)) return action;
      if (!["dispatching", "unknown"].includes(action.state)) return null;
      return save(action, { state: outcome.state, outcome });
    },
    async cancellationRequested(id: string) {
      await lock();
      return (await row(id))?.cancellationRequested ?? false;
    },
    async requestCancellation(id: string, inputTask: ActionTask, workspaceId: string) {
      const worker = actionTaskSchema.parse(inputTask);
      await lock();
      const stored = await row(id);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      if (
        action.request.task.id !== worker.id ||
        action.request.authorization.target.kind !== "workspace" ||
        action.request.authorization.target.id !== workspaceId ||
        action.request.authorization.operation !== "workspace.command" ||
        !running(await task(worker.id), worker)
      )
        return null;
      if (
        stored.cancellationRequested ||
        !["pending", "approved", "dispatching", "unknown"].includes(action.state)
      )
        return action;
      await transaction.execute(sql`
        UPDATE winston.actions SET cancellation_requested = true
        WHERE owner_id = ${ownerId}::uuid AND id = ${action.id}::uuid
      `);
      return save(
        action,
        ["pending", "approved"].includes(action.state) ? { state: "invalidated" } : {},
      );
    },
    // Trusted reconciliation resolves the original immutable execution, including after cancellation.
    async workspaceExecution(input: WorkspaceOperation) {
      const operation = workspaceOperationSchema.parse(input);
      await lock();
      const result = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid
          AND document->>'operationId' = ${operation.operationId} FOR UPDATE
      `);
      if (!result.rows[0]) return null;
      const action = actionRecordSchema.parse(result.rows[0].document);
      return matchesExecution(action, operation) ? action : null;
    },
    async authorizeWorkspace(input: WorkspaceCommand) {
      const command = workspaceCommandSchema.parse(input);
      await lock();
      const stored = await row(command.dispatch.id);
      if (
        !stored ||
        stored.cancellationRequested ||
        stored.tokenHash !== hash(command.dispatch.token)
      )
        return false;
      const action = actionRecordSchema.parse(stored.document);
      if (
        action.state !== "dispatching" ||
        !matchesExecution(action, command.operation) ||
        hash(canonical(command.input)) !== command.operation.inputHash
      )
        return false;
      const current = await task(command.operation.taskId);
      if (
        !action.dispatchTask ||
        !running(current, action.dispatchTask) ||
        !sameIntent(current, action)
      )
        return false;
      const evaluation = await policy(action);
      return (
        evaluation.decision === "allow" ||
        (evaluation.decision === "ask" && action.decisionSource === "owner")
      );
    },
    async find(id: string) {
      await lock();
      const stored = await row(id);
      return stored ? actionRecordSchema.parse(stored.document) : null;
    },
    async prepare(input: ActionRequest) {
      const request = actionRequestSchema.parse(input);
      const digest = hash(canonical(request));
      await lock();
      const existing = await transaction.execute<{ document: unknown; hash: string }>(sql`
        SELECT document, request_hash AS hash FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND request_key = ${request.key}
      `);
      const previous = existing.rows[0];
      if (previous) {
        if (previous.hash !== digest)
          throw new Error("Action key conflicts with its original arguments or authority.");
        return actionRecordSchema.parse(previous.document);
      }
      const current = await task(request.task.id);
      if (!running(current, request.task) || !current)
        throw new Error("Action task lease is stale.");
      if (
        request.bindingKey &&
        !(await taskResourceRepository(transaction, ownerId).matches(
          request.task.id,
          current.intentRevision,
          request.bindingKey,
          request.authorization,
        ))
      )
        throw new Error("Action does not match its task resource binding.");
      const decision = await authorizationRepository(transaction, ownerId).evaluate(
        request.authorization,
      );
      const clock = await transaction.execute<{ expiresAt: string }>(
        sql`SELECT clock_timestamp() + interval '15 minutes' AS "expiresAt"`,
      );
      const expiration = clock.rows[0]?.expiresAt;
      if (!expiration) throw new Error("Database clock unavailable.");
      const expiresAt = new Date(expiration).toISOString();
      const action = actionRecordSchema.parse({
        id: randomUUID(),
        request,
        hash: digest,
        intentRevision: current.intentRevision,
        snapshot: decision.snapshot,
        state:
          decision.decision === "allow"
            ? "approved"
            : decision.decision === "ask"
              ? "pending"
              : "denied",
        revision: 0,
        expiresAt,
        decisionSource: decision.decision === "ask" ? null : "policy",
        operationId: randomUUID(),
        dispatchTask: null,
        outcome: null,
      });
      await transaction.execute(sql`
        INSERT INTO winston.actions (owner_id, id, task_id, request_key, request_hash, document, expires_at)
        VALUES (${ownerId}::uuid, ${action.id}::uuid, ${request.task.id}::uuid, ${request.key}, ${digest}, ${JSON.stringify(action)}::jsonb, ${action.expiresAt}::timestamptz)
      `);
      await publish(action);
      return action;
    },
    // Authenticated owner interaction only; never expose this as a model/worker/device tool.
    async decide(input: ActionDecision) {
      const decision = actionDecisionSchema.parse(input);
      await lock();
      const stored = await row(decision.id);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      if (
        action.revision !== decision.revision ||
        action.hash !== decision.hash ||
        action.state !== "pending"
      )
        return null;
      const current = await task(action.request.task.id);
      const evaluation = await policy(action);
      if (!stored.valid || !sameIntent(current, action) || evaluation.decision === "deny") {
        return save(action, { state: "invalidated" });
      }
      return save(action, {
        state: decision.approve ? "approved" : "denied",
        decisionSource: "owner",
      });
    },
    async claim(id: string, expectedHash: string, inputTask: ActionTask) {
      const worker = actionTaskSchema.parse(inputTask);
      await lock();
      const stored = await row(id);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      if (action.hash !== expectedHash || action.request.task.id !== worker.id) return null;
      if (action.state !== "approved") return { claimed: false as const, action };
      if (stored.cancellationRequested)
        return { claimed: false as const, action: await save(action, { state: "invalidated" }) };
      const current = await task(worker.id);
      if (!running(current, worker)) return null;
      const evaluation = await policy(action);
      if (
        !stored.valid ||
        !sameIntent(current, action) ||
        evaluation.decision === "deny" ||
        (evaluation.decision === "ask" && action.decisionSource !== "owner")
      ) {
        return { claimed: false as const, action: await save(action, { state: "invalidated" }) };
      }
      // The commit of this transition is the cancel-versus-dispatch linearization point.
      // Callers MUST commit before contacting any external executor/provider.
      const token = `wda_${randomBytes(32).toString("base64url")}`;
      await transaction.execute(
        sql`UPDATE winston.actions SET dispatch_token_hash = ${hash(token)} WHERE owner_id = ${ownerId}::uuid AND id = ${id}::uuid`,
      );
      return {
        claimed: true as const,
        token,
        action: await save(action, { state: "dispatching", dispatchTask: worker }),
      };
    },
    // A trusted adapter reports facts about an already dispatched effect, even after task cancellation.
    // The receipt does not authorize another dispatch. Unknown outcomes require provider-specific evidence.
    async report(id: string, token: string, input: ActionOutcome) {
      const outcome = actionOutcomeSchema.parse(input);
      await lock();
      const stored = await row(id);
      if (!stored || stored.tokenHash !== hash(token)) return null;
      const action = actionRecordSchema.parse(stored.document);
      if (action.outcome && canonical(action.outcome) === canonical(outcome)) return action;
      if (!["dispatching", "unknown"].includes(action.state)) return null;
      return save(action, { state: outcome.state, outcome });
    },
    async recover(id: string) {
      await lock();
      const stored = await row(id);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      if (action.state !== "dispatching") return action;
      const current = await task(action.request.task.id);
      if (action.dispatchTask && running(current, action.dispatchTask)) return action;
      return save(action, {
        state: "unknown",
        outcome: {
          state: "unknown",
          detail: "Execution ended without a confirmed outcome.",
          providerReference: null,
        },
      });
    },
    // Trusted adapter reconciliation only. The adapter must independently verify the external
    // operation and its evidence; an operation ID alone is never a public authorization token.
    async reconcile(id: string, operationId: string, input: ActionOutcome) {
      const outcome = actionOutcomeSchema.parse(input);
      if (outcome.state === "unknown" || !outcome.providerReference) return null;
      await lock();
      const stored = await row(id);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      if (action.state !== "unknown" || action.operationId !== operationId) return null;
      return save(action, { state: outcome.state, outcome });
    },
  };
}

export type ActionRepository = ReturnType<typeof actionRepository>;
