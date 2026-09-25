import { createHash } from "node:crypto";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import {
  cliCalendarReconciliationRequestSchema,
  type CliCalendarReconciliationRequest,
  type CliResult,
} from "@winston/contracts/cli";
import { calendarMutationSnapshotSchema } from "@winston/contracts/calendar-mutations";
import type { ActionRecord } from "@winston/contracts/actions";
import type { GoogleReadOptions } from "./read-request";
import { createConnectedReadGateway } from "./cli-reads";
import { readCalendarMutationArguments } from "./calendar-mutation-plan";
import { calendarMutationStateMatches } from "./calendar-reconciliation-evidence";

type Options = Pick<GoogleReadOptions, "database" | "google" | "fetch">;
const uncertain = (id: string): CliResult => ({
  version: 1,
  status: "unknown",
  referenceId: id,
  message:
    "The Calendar result remains unresolved. No write was resent. A later explicit read may use a new observation key.",
});
function receipt(action: ActionRecord): CliResult {
  if (action.state !== "succeeded")
    return {
      version: 1,
      status: action.state === "failed" ? "unavailable" : "denied",
      referenceId: action.id,
      message: action.outcome?.detail ?? "This Calendar operation did not succeed.",
    };
  return {
    version: 1,
    status: "ok",
    data: {
      actionId: action.id,
      state: action.state,
      outcome: action.outcome,
    },
  };
}

export function createCalendarReconciliationGateway(options: Options) {
  const { database } = options;
  const read = createConnectedReadGateway(options);
  return async (
    credential: ServiceRequest,
    input: CliCalendarReconciliationRequest,
    inputSignal: AbortSignal,
  ): Promise<CliResult> => {
    const parsed = cliCalendarReconciliationRequestSchema.safeParse(input);
    if (!parsed.success)
      return {
        version: 1,
        status: "invalid_input",
        message: "Provide an operation ID and stable observation key.",
      };
    const request = parsed.data;
    const authority = await database.authenticateService(credential);
    if (authority?.operation !== "gateway:control")
      return {
        version: 1,
        status: "denied",
        message: "Task control authority is unavailable or expired.",
      };
    const ownerId = authority.ownerId;
    const signal = AbortSignal.any([inputSignal, AbortSignal.timeout(45_000)]);
    try {
      const action = await database.transaction(ownerId, async ({ actions }) => {
        const found = await actions.find(request.id);
        if (found?.request.authorization.operation !== "calendar.write") return null;
        return actions.recover(found.id);
      });
      if (!action)
        return { version: 1, status: "denied", message: "This Calendar operation is unavailable." };
      if (["succeeded", "failed", "denied", "invalidated"].includes(action.state))
        return receipt(action);
      if (action.state !== "unknown") return uncertain(action.id);
      const { plan } = readCalendarMutationArguments(action.request.arguments);
      const target = plan.request.target;
      const observation = await read(
        credential,
        {
          version: 1,
          command: "calendar.event",
          accountId: target.connectionId,
          calendarId: target.calendarId,
          id: plan.eventId,
          key: `calendar-check:${createHash("sha256")
            .update(JSON.stringify([action.id, request.key]))
            .digest("hex")}`,
        },
        signal,
      );
      if (observation.status !== "ok")
        return observation.status === "waiting" || observation.status === "denied"
          ? observation
          : uncertain(action.id);
      const snapshot = calendarMutationSnapshotSchema.safeParse(observation.data);
      if (!snapshot.success) return uncertain(action.id);
      const source = snapshot.data.source;
      if (
        source.connectionId !== target.connectionId ||
        source.calendarId !== target.calendarId ||
        source.connectionRevision !== target.connectionRevision ||
        source.preferencesRevision !== target.preferencesRevision ||
        source.task?.id !== authority.taskId ||
        !calendarMutationStateMatches(plan, snapshot.data.event)
      )
        return uncertain(action.id);
      signal.throwIfAborted();
      const reconciled = await database.transaction(ownerId, async (scope) => {
        const current = await scope.capabilities.authenticate(credential);
        if (
          current?.operation !== "gateway:control" ||
          current.taskId !== authority.taskId ||
          current.revision !== authority.revision ||
          current.generation !== authority.generation
        )
          return null;
        const connection = await scope.connections.find(target.connectionId);
        const preferences = await scope.connectionTargets.preferences();
        if (
          connection?.revision !== target.connectionRevision ||
          preferences.revision !== target.preferencesRevision
        )
          return null;
        return scope.actions.reconcile(action.id, action.operationId, {
          state: "succeeded",
          providerReference: plan.eventId,
          detail:
            "A provider read verified the requested event state. This does not establish who made the change or confirm guest-notification delivery. No write was resent.",
        });
      });
      return reconciled ? receipt(reconciled) : uncertain(action.id);
    } catch {
      return uncertain(request.id);
    }
  };
}
