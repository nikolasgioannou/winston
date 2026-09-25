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
import { readCalendarMutationArguments } from "../google/calendar-mutation-plan";
import { readGmailMutationPlan } from "../google/gmail-mutation-plan";
import { gmailActionReferencesCurrent } from "./gmail-action-references";
import { gmailLabelActionReferencesCurrent } from "./gmail-label-action-references";
import { readGmailLabelMutationPlan } from "../google/gmail-label-mutation-plan";
import { assertGmailMutationResolved } from "./gmail-mutation-blocking";
import { connectionTargetRepository } from "./connection-targets";
import { assertCalendarMutationResolved } from "./calendar-mutation-blocking";
import { deviceMessageSchema, type DeviceMessage } from "@winston/contracts/devices";
import { deviceExecutionSchema } from "@winston/contracts/device-executions";
import { deviceSessionRepository } from "./device-sessions";
import { responsibilityTaskAllowed } from "./responsibility-bindings";
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
type ConnectionProof = {
  id: string;
  token: string;
  task: ActionTask;
  authorization: ActionRequest["authorization"];
  arguments: ActionRequest["arguments"];
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
      !(await responsibilityTaskAllowed(
        transaction,
        ownerId,
        action.request.task.id,
        action.request.authorization,
      ))
    )
      return { ...evaluation, decision: "deny" as const, reason: "stale" as const };
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

  async function priorEffect(taskId: string, intentRevision: number) {
    const rows = await transaction.execute<{ document: unknown }>(sql`
      SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND task_id = ${taskId}::uuid
        AND document->>'state' IN ('dispatching', 'unknown')
        AND (document->>'intentRevision')::integer <> ${intentRevision}
      ORDER BY id LIMIT 1
    `);
    return rows.rows[0] ? actionRecordSchema.parse(rows.rows[0].document) : null;
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

  async function authorizeConnection(input: ConnectionProof, operations: string[]) {
    const worker = actionTaskSchema.parse(input.task);
    const expected = actionRequestSchema.parse({
      key: "connection-proof",
      task: worker,
      authorization: input.authorization,
      arguments: input.arguments,
    });
    const target = expected.authorization.target;
    if (target.kind !== "connection" || !operations.includes(expected.authorization.operation))
      return false;
    await lock();
    const stored = await row(input.id);
    if (!stored || stored.cancellationRequested || stored.tokenHash !== hash(input.token))
      return false;
    const action = actionRecordSchema.parse(stored.document);
    if (
      action.state !== "dispatching" ||
      canonical(action.request.authorization) !== canonical(expected.authorization) ||
      canonical(action.request.arguments) !== canonical(expected.arguments) ||
      canonical(action.dispatchTask) !== canonical(worker)
    )
      return false;
    const current = await task(worker.id);
    if (!running(current, worker) || !sameIntent(current, action)) return false;
    const evaluation = await policy(action);
    if (["gmail.draft", "gmail.send"].includes(expected.authorization.operation)) {
      let plan;
      try {
        plan = readGmailMutationPlan(action.request.arguments);
      } catch {
        return false;
      }
      const planned = plan.prepared.target;
      if (
        plan.prepared.operationId !== action.operationId ||
        planned.operation !== expected.authorization.operation ||
        planned.connectionId !== target.id ||
        target.resource !== null ||
        planned.task?.id !== action.request.task.id ||
        planned.task.revision !== action.request.task.revision ||
        !(await gmailActionReferencesCurrent(transaction, ownerId, plan))
      )
        return false;
    }
    if (expected.authorization.operation === "gmail.modify") {
      let plan;
      try {
        plan = readGmailLabelMutationPlan(action.request.arguments);
      } catch {
        return false;
      }
      if (
        plan.operationId !== action.operationId ||
        plan.target.connectionId !== target.id ||
        target.resource !== null ||
        plan.target.task?.id !== action.request.task.id ||
        plan.target.task.revision !== action.request.task.revision ||
        !(await gmailLabelActionReferencesCurrent(transaction, ownerId, plan))
      )
        return false;
    }
    if (expected.authorization.operation === "calendar.write") {
      let payload;
      try {
        payload = readCalendarMutationArguments(action.request.arguments);
      } catch {
        return false;
      }
      const planned = payload.plan.request.target;
      const preferences = await connectionTargetRepository(transaction, ownerId).preferences();
      if (
        payload.plan.operationId !== action.operationId ||
        planned.connectionId !== target.id ||
        planned.calendarId !== target.resource ||
        planned.task?.id !== action.request.task.id ||
        planned.task.revision !== action.request.task.revision ||
        planned.preferencesRevision !== preferences.revision ||
        planned.connectionRevision !== evaluation.resourceRevision
      )
        return false;
    }
    return (
      evaluation.decision === "allow" ||
      (evaluation.decision === "ask" && action.decisionSource === "owner")
    );
  }

  return {
    // Trusted runtime only. This may stop an existing reservation, never authorize a send.
    async continueDevice(inputId: string) {
      const id = actionRecordSchema.shape.operationId.parse(inputId);
      await lock();
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.device_executions
        WHERE owner_id = ${ownerId}::uuid AND execution_id = ${id}::uuid
      `);
      if (!rows.rows[0]) return false;
      const execution = deviceExecutionSchema.parse(rows.rows[0].document);
      const original = execution.message.payload;
      if (original.kind !== "execute" || original.executionId !== id) return false;
      const stored = await row(execution.actionId);
      if (!stored || stored.cancellationRequested) return false;
      const action = actionRecordSchema.parse(stored.document);
      const target = action.request.authorization.target;
      if (
        !["dispatching", "unknown"].includes(action.state) ||
        !["dispatching", "accepted", "running", "unknown"].includes(execution.state) ||
        action.operationId !== id ||
        target.kind !== "device" ||
        target.id !== execution.message.deviceId ||
        target.resource !== null ||
        action.request.authorization.operation !== `device.${original.operation.kind}` ||
        canonical(action.request.arguments) !== canonical(original.operation) ||
        canonical(action.dispatchTask) !== canonical(execution.task) ||
        original.taskId !== execution.task.id ||
        original.taskRevision !== execution.task.revision
      )
        return false;
      const current = await task(execution.task.id);
      if (!running(current, execution.task) || !sameIntent(current, action)) return false;
      const evaluation = await policy(action);
      return (
        evaluation.decision === "allow" ||
        (evaluation.decision === "ask" && action.decisionSource === "owner")
      );
    },
    // Trusted adapter only. Read persisted evidence rather than accepting a caller's
    // claimed outcome. This never grants dispatch authority or repeats an effect.
    async reconcileDevice(inputId: string) {
      const id = actionRecordSchema.shape.operationId.parse(inputId);
      await lock();
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.device_executions
        WHERE owner_id = ${ownerId}::uuid AND execution_id = ${id}::uuid
      `);
      if (!rows.rows[0]) return null;
      const execution = deviceExecutionSchema.parse(rows.rows[0].document);
      const original = execution.message.payload;
      if (original.kind !== "execute" || original.executionId !== id) return null;
      const stored = await row(execution.actionId);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      const target = action.request.authorization.target;
      if (
        action.operationId !== id ||
        target.kind !== "device" ||
        target.id !== execution.message.deviceId ||
        target.resource !== null ||
        action.request.authorization.operation !== `device.${original.operation.kind}` ||
        canonical(action.request.arguments) !== canonical(original.operation) ||
        canonical(action.dispatchTask) !== canonical(execution.task) ||
        original.taskId !== execution.task.id ||
        original.taskRevision !== execution.task.revision
      )
        return null;
      if (["dispatching", "accepted", "running"].includes(execution.state)) return action;
      const state =
        execution.state === "succeeded"
          ? "succeeded"
          : execution.state === "unknown"
            ? "unknown"
            : "failed";
      const detail =
        execution.state === "succeeded"
          ? "Device operation completed."
          : execution.state === "canceled"
            ? "Device operation was canceled; earlier effects may remain."
            : execution.state === "unknown"
              ? "Device operation outcome is unknown; do not repeat it."
              : "Device operation failed; earlier effects may remain.";
      const outcome = actionOutcomeSchema.parse({ state, detail, providerReference: id });
      if (action.outcome && canonical(action.outcome) === canonical(outcome)) return action;
      if (!["dispatching", "unknown"].includes(action.state)) return null;
      return save(action, { state: outcome.state, outcome });
    },
    // A proof check only: the dispatcher must reserve durably before sending once.
    async authorizeDevice(input: {
      id: string;
      token: string;
      task: ActionTask;
      message: DeviceMessage;
    }) {
      const worker = actionTaskSchema.parse(input.task);
      const message = deviceMessageSchema.parse(input.message);
      const operation = message.payload;
      if (operation.kind !== "execute") return false;
      await lock();
      const stored = await row(input.id);
      if (!stored || stored.cancellationRequested || stored.tokenHash !== hash(input.token))
        return false;
      const action = actionRecordSchema.parse(stored.document);
      const { target } = action.request.authorization;
      if (
        action.state !== "dispatching" ||
        target.kind !== "device" ||
        target.id !== message.deviceId ||
        target.resource !== null ||
        action.operationId !== operation.executionId ||
        action.request.authorization.operation !== `device.${operation.operation.kind}` ||
        canonical(action.request.arguments) !== canonical(operation.operation) ||
        canonical(action.dispatchTask) !== canonical(worker) ||
        operation.taskId !== worker.id ||
        operation.taskRevision !== worker.revision
      )
        return false;
      const current = await task(worker.id);
      if (!running(current, worker) || !sameIntent(current, action)) return false;
      const evaluation = await policy(action);
      if (
        evaluation.decision !== "allow" &&
        !(evaluation.decision === "ask" && action.decisionSource === "owner")
      )
        return false;
      const supported = await deviceSessionRepository(transaction, ownerId).supports(
        {
          deviceId: message.deviceId,
          sessionId: message.sessionId,
          generation: message.generation,
        },
        operation.operation.kind,
      );
      if (!supported) return false;
      // Use database time after lock acquisition, matching task and device leases.
      const deadline = await transaction.execute(sql`
        SELECT 1 WHERE ${operation.deadline}::numeric > extract(epoch FROM clock_timestamp()) * 1000
      `);
      return deadline.rows.length === 1;
    },
    // Server-side adapters only. Dispatch tokens never leave the API process.
    authorizeConnectionRead(input: ConnectionProof) {
      return authorizeConnection(input, ["gmail.read", "calendar.read"]);
    },
    authorizeCalendarMutation(input: ConnectionProof) {
      return authorizeConnection(input, ["calendar.write"]);
    },
    authorizeGmailMutation(input: ConnectionProof) {
      return authorizeConnection(input, ["gmail.draft", "gmail.send"]);
    },
    authorizeGmailLabelMutation(input: ConnectionProof) {
      return authorizeConnection(input, ["gmail.modify"]);
    },
    async unresolvedPriorEffect(input: ActionTask) {
      const worker = actionTaskSchema.parse(input);
      await lock();
      const current = await task(worker.id);
      if (!current || !running(current, worker))
        throw new Error("Worker lease is stale or expired.");
      return priorEffect(worker.id, current.intentRevision);
    },
    async taskEffects(inputId: string) {
      const id = actionTaskSchema.shape.id.parse(inputId);
      const counts = await transaction.execute<{ unresolved: number }>(sql`
        SELECT count(*)::int AS unresolved FROM winston.actions
        WHERE owner_id = ${ownerId}::uuid AND task_id = ${id}::uuid
          AND document->>'state' IN ('dispatching', 'unknown')
      `);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT document FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND task_id = ${id}::uuid
          AND document->'dispatchTask' <> 'null'::jsonb ORDER BY id LIMIT 20
      `);
      return {
        unresolved: counts.rows[0]?.unresolved ?? 0,
        actions: rows.rows.map((row) => {
          const action = actionRecordSchema.parse(row.document);
          return {
            id: action.id,
            state: action.state,
            outcome: action.outcome
              ? { ...action.outcome, detail: action.outcome.detail.slice(0, 2000) }
              : null,
            detailTruncated: (action.outcome?.detail.length ?? 0) > 2000,
          };
        }),
      };
    },
    async stoppedWorkspaceCommands(afterId = "00000000-0000-0000-0000-000000000000") {
      const cursor = actionRecordSchema.shape.id.parse(afterId);
      const rows = await transaction.execute<{ document: unknown }>(sql`
        SELECT a.document FROM winston.actions a
        JOIN winston.tasks t ON t.owner_id = a.owner_id AND t.id = a.task_id
        WHERE a.owner_id = ${ownerId}::uuid AND a.id > ${cursor}::uuid
          AND a.document->>'state' IN ('dispatching', 'unknown')
          AND a.document->'request'->'authorization'->'target'->>'kind' = 'workspace'
          AND a.document->'request'->'authorization'->>'operation' = 'workspace.command'
          AND (a.cancellation_requested OR t.document->>'state' IN ('canceled', 'failed', 'succeeded')
            OR (a.document->>'intentRevision')::integer <> t.intent_revision)
        ORDER BY a.id LIMIT 4
      `);
      return rows.rows.map((row) => actionRecordSchema.parse(row.document));
    },
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
      const target = action.request.authorization.target;
      const supported =
        target.kind === "workspace"
          ? target.id === workspaceId &&
            action.request.authorization.operation === "workspace.command"
          : target.kind === "device" && action.request.authorization.operation === "device.command";
      if (
        action.request.task.id !== worker.id ||
        !supported ||
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
    async expirePending(id: string) {
      await lock();
      const stored = await row(id);
      if (!stored) return null;
      const action = actionRecordSchema.parse(stored.document);
      return action.state === "pending" && !stored.valid
        ? save(action, { state: "invalidated" })
        : action;
    },
    async prepare(input: ActionRequest, options?: { operationId: string }) {
      const request = actionRequestSchema.parse(input);
      const operationId = options
        ? actionRecordSchema.shape.operationId.parse(options.operationId)
        : randomUUID();
      const digest = hash(canonical(request));
      await lock();
      const existing = await transaction.execute<{ document: unknown; hash: string }>(sql`
        SELECT document, request_hash AS hash FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND request_key = ${request.key}
      `);
      const previous = existing.rows[0];
      if (previous) {
        const existingAction = actionRecordSchema.parse(previous.document);
        if (previous.hash !== digest || (options && existingAction.operationId !== operationId))
          throw new Error("Action key conflicts with its original arguments or authority.");
        return existingAction;
      }
      if (options) {
        const reused = await transaction.execute(sql`
          SELECT id FROM winston.actions WHERE owner_id = ${ownerId}::uuid
            AND document->>'operationId' = ${operationId} LIMIT 1
        `);
        if (reused.rows.length) throw new Error("Action operation identity is already in use.");
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
      if (
        !(await responsibilityTaskAllowed(
          transaction,
          ownerId,
          request.task.id,
          request.authorization,
        ))
      ) {
        decision.decision = "deny";
        decision.reason = "stale";
      }
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
        operationId,
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
      if (!current || !running(current, worker)) return null;
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
      if (await priorEffect(worker.id, current.intentRevision))
        return { claimed: false as const, action };
      if (action.request.authorization.operation === "calendar.write")
        await assertCalendarMutationResolved(transaction, ownerId, worker.id, action.id);
      if (
        ["gmail.draft", "gmail.send", "gmail.modify"].includes(
          action.request.authorization.operation,
        )
      )
        await assertGmailMutationResolved(transaction, ownerId, worker.id, action.id);
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
