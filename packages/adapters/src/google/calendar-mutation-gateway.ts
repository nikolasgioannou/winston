import { createHash, randomUUID } from "node:crypto";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import {
  calendarMutationInputSchema,
  calendarMutationSnapshotSchema,
  type CalendarMutationInput,
  type CalendarMutationSnapshot,
} from "@winston/contracts/calendar-mutations";
import type { GoogleReadOptions } from "./read-request";
import { createConnectedReadGateway } from "./cli-reads";
import { createConnectionTargets } from "./targets";
import { sameResolvedTarget } from "./target-resolution";
import { prepareCalendarMutation, readCalendarMutationArguments } from "./calendar-mutation-plan";
import { createCalendarMutationExecutor } from "./calendar-mutation-executor";
import { CalendarMutationBlockedError } from "../database/calendar-mutation-blocking";

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch">;
function result(
  status: Exclude<CliResult["status"], "ok">,
  message: string,
  referenceId?: string,
): CliResult {
  return { version: 1, status, message, ...(referenceId ? { referenceId } : {}) };
}

export function createCalendarMutationGateway(options: Options) {
  const { database } = options;
  const targets = createConnectionTargets(database, options.google);
  const read = createConnectedReadGateway(options);
  const execute = createCalendarMutationExecutor(options);
  return async (
    credential: ServiceRequest,
    input: CalendarMutationInput,
    inputSignal: AbortSignal,
  ): Promise<CliResult> => {
    const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(45_000)]);
    const parsed = calendarMutationInputSchema.safeParse(input);
    if (!parsed.success)
      return result("invalid_input", "Provide a valid Calendar change and stable request key.");
    const { key, intent } = parsed.data;
    const authority = await database.authenticateService(credential);
    if (authority?.operation !== "gateway:control")
      return result("denied", "Task control authority is unavailable or expired.");
    const ownerId = authority.ownerId;
    const worker = {
      id: authority.taskId,
      revision: authority.revision,
      generation: authority.generation,
    };
    const live = async () => {
      const current = await database.authenticateService(credential);
      return (
        current?.ownerId === ownerId &&
        current.taskId === worker.id &&
        current.revision === worker.revision &&
        current.generation === worker.generation
      );
    };
    try {
      signal.throwIfAborted();
      // This lookup precedes inventory/inspection, retaining the original plan across approval waits.
      let action = await database.transaction(ownerId, ({ calendarActions }) =>
        calendarActions.find(worker, key, intent),
      );
      if (!action) {
        const selected = await targets.resolve(
          ownerId,
          {
            operation: "calendar.write",
            explicit: { connectionId: intent.accountId, calendarId: intent.calendarId },
            task: { id: worker.id, revision: worker.revision },
          },
          signal,
        );
        if (selected.status !== "resolved")
          return result(
            "unavailable",
            "The selected Calendar account or writable calendar is unavailable.",
          );
        let snapshot: CalendarMutationSnapshot | undefined;
        if (intent.kind !== "create") {
          const inspection = await read(
            credential,
            {
              version: 1,
              command: "calendar.event",
              accountId: intent.accountId,
              calendarId: intent.calendarId,
              id: intent.eventId,
              key: `calendar-inspect:${createHash("sha256").update(key).digest("hex")}`,
            },
            signal,
          );
          if (inspection.status !== "ok") return inspection;
          snapshot = calendarMutationSnapshotSchema.parse(inspection.data);
          if (
            snapshot.source.task?.id !== worker.id ||
            !sameResolvedTarget(
              {
                ...snapshot.source,
                operation: "calendar.write",
                task: selected.target.task,
              },
              selected.target,
            )
          )
            throw new Error("Calendar inspection provenance changed.");
          // A cached, intent-bound read survives its approval wait. Only its task lease changes;
          // event content, provider version and connection/preferences revisions remain exact.
          snapshot = { ...snapshot, source: { ...snapshot.source, task: selected.target.task } };
        }
        const { accountId, calendarId, ...details } = intent;
        if (accountId !== selected.target.connectionId || calendarId !== selected.target.calendarId)
          throw new Error("Calendar target changed.");
        const plan = prepareCalendarMutation(
          randomUUID(),
          { ...details, target: selected.target },
          snapshot,
        );
        signal.throwIfAborted();
        action = await database.transaction(ownerId, async (scope) => {
          if (!(await scope.capabilities.authenticate(credential)))
            throw new Error("Task authority expired.");
          return scope.calendarActions.prepare(worker, key, intent, plan);
        });
      }
      if (!(await live()))
        return result("denied", "Task control authority is unavailable or expired.");
      if (action.state === "dispatching") {
        const dispatchedId = action.id;
        const recovered = await database.transaction(ownerId, ({ actions }) =>
          actions.recover(dispatchedId),
        );
        if (recovered) action = recovered;
      }
      if (action.state === "pending") {
        const pending = action;
        const waiting = await database.transaction(ownerId, async (scope) => {
          if (!(await scope.capabilities.authenticate(credential))) return false;
          const current = await scope.actions.expirePending(pending.id);
          const policy = await scope.authorization.evaluate(
            pending.request.authorization,
            pending.snapshot ?? undefined,
          );
          const preferences = await scope.connectionTargets.preferences();
          const { plan } = readCalendarMutationArguments(pending.request.arguments);
          if (
            current?.state !== "pending" ||
            policy.decision === "deny" ||
            preferences.revision !== plan.request.target.preferencesRevision
          )
            return false;
          await scope.tasks.finishStep(worker.id, worker.revision, worker.generation, {
            state: "waiting",
            blocker: {
              kind: "approval",
              referenceId: pending.id,
              detail: "Review the exact Calendar change.",
            },
          });
          return true;
        });
        return waiting
          ? result(
              "waiting",
              "Waiting for approval of this exact Calendar change. Resume with the same key and arguments.",
              action.id,
            )
          : result("denied", "This Calendar approval expired or its authority changed.", action.id);
      }
      if (action.state === "approved") {
        const completed = await execute(ownerId, action.id, action.hash, worker, signal);
        if (!completed)
          return result(
            "denied",
            "This Calendar change no longer has a current task or approval.",
            action.id,
          );
        action = completed;
      }
      if (action.state === "succeeded") {
        const { plan } = readCalendarMutationArguments(action.request.arguments);
        return {
          version: 1,
          status: "ok",
          data: { actionId: action.id, eventId: plan.eventId, kind: plan.request.kind },
        };
      }
      if (["denied", "invalidated"].includes(action.state))
        return result("denied", "This Calendar change is not authorized.", action.id);
      if (action.state === "failed")
        return result(
          "unavailable",
          action.outcome?.detail ?? "The Calendar change was not completed.",
          action.id,
        );
      return result(
        "unknown",
        "A Calendar write is still in flight or has no confirmed result. Reconcile it; do not retry with a new key.",
        action.id,
      );
    } catch (error) {
      if (error instanceof CalendarMutationBlockedError)
        return result(
          "unknown",
          "An earlier Calendar write for this task remains unresolved. Reconcile it before preparing another write.",
          error.actionId,
        );
      if (!(await live()))
        return result("denied", "Task control authority is unavailable or expired.");
      return result(
        "unavailable",
        "The Calendar change could not be prepared safely. Check its event version, scope and current account permissions.",
      );
    }
  };
}
