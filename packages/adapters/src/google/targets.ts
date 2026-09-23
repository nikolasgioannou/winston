import type { createDatabase } from "../database";
import type { GoogleConnections } from "./index";
import {
  targetSelectionSchema,
  type TargetSelection,
  type ResolvedTarget,
} from "@winston/contracts/connection-targets";
import {
  resolveConnectionTarget,
  targetChoices,
  sameResolvedTarget,
  type TargetCatalog,
  type TargetResolution,
} from "./target-resolution";

export { labelSearchResults } from "./target-resolution";

export function createConnectionTargets(
  database: ReturnType<typeof createDatabase>,
  google: Pick<GoogleConnections, "list" | "calendars">,
) {
  async function select(
    ownerId: string,
    input: TargetSelection,
    signal: AbortSignal,
    search = false,
  ): Promise<TargetResolution | { status: "search"; targets: ResolvedTarget[] }> {
    const selection = targetSelectionSchema.parse(input);
    const listed = await google.list(ownerId);
    const service = selection.operation.startsWith("gmail.") ? "gmail" : "calendar";
    const catalog: TargetCatalog = [];
    // Provider calls happen outside the transaction; their connection versions are checked below.
    for (const connection of listed.filter((entry) => entry.service === service)) {
      if (!["connected", "limited"].includes(connection.status)) continue;
      try {
        catalog.push({
          connection,
          calendars:
            service === "calendar" ? await google.calendars(ownerId, connection.id, signal) : [],
        });
      } catch {
        if (signal.aborted) throw signal.reason;
        // Partial inventory must not make an ambiguous request appear unambiguous.
        throw new Error("Calendar inventory is unavailable. Try again before selecting a target.");
      }
    }
    return database.transaction(ownerId, async (scope) => {
      const preferences = await scope.connectionTargets.preferences();
      if (!(await scope.connectionTargets.currentTask(selection))) return { status: "unavailable" };
      const binding = await scope.connectionTargets.binding(selection);
      const eligible: TargetCatalog = [];
      for (const entry of catalog) {
        const current = await scope.connections.find(entry.connection.id);
        if (!current || current.revision !== entry.connection.revision) continue;
        const choices = targetChoices([entry], preferences, selection);
        const calendars = [];
        let gmailEligible = false;
        for (const choice of choices) {
          const policy = await scope.authorization.evaluate({
            target: { kind: "connection", id: choice.connectionId, resource: choice.calendarId },
            operation: selection.operation,
          });
          if (policy.decision === "deny") continue;
          if (choice.calendarId === null) gmailEligible = true;
          else
            calendars.push(
              ...entry.calendars.filter((calendar) => calendar.id === choice.calendarId),
            );
        }
        if (gmailEligible || calendars.length) eligible.push({ connection: current, calendars });
      }
      if (search)
        return { status: "search", targets: targetChoices(eligible, preferences, selection) };
      const result = resolveConnectionTarget(eligible, preferences, selection, binding);
      if (result.status === "resolved" && selection.task)
        await scope.connectionTargets.bind(selection, {
          connectionId: result.target.connectionId,
          calendarId: result.target.calendarId,
        });
      return result;
    });
  }
  async function resolve(
    ownerId: string,
    selection: TargetSelection,
    signal: AbortSignal,
  ): Promise<TargetResolution> {
    const result = await select(ownerId, selection, signal);
    if (result.status === "search") throw new Error("Unexpected search resolution.");
    return result;
  }
  return {
    resolve,
    async searchTargets(
      ownerId: string,
      operation: "gmail.read" | "calendar.read",
      signal: AbortSignal,
    ) {
      if (!["gmail.read", "calendar.read"].includes(operation))
        throw new Error("Search requires a read operation.");
      const result = await select(ownerId, { operation }, signal, true);
      return result.status === "search" ? result.targets : [];
    },
    async revalidate(ownerId: string, target: ResolvedTarget, signal: AbortSignal) {
      const result = await resolve(
        ownerId,
        {
          operation: target.operation,
          ...(["gmail.read", "calendar.read"].includes(target.operation)
            ? { explicit: { connectionId: target.connectionId, calendarId: target.calendarId } }
            : {}),
          ...(target.task
            ? { task: target.task }
            : {
                explicit: { connectionId: target.connectionId, calendarId: target.calendarId },
              }),
        },
        signal,
      );
      return result.status === "resolved" && sameResolvedTarget(result.target, target);
    },
  };
}
