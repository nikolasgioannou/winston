import type { Connection, GoogleCalendar } from "@winston/contracts/connections";
import {
  targetSelectionSchema,
  type ConnectionTarget,
  type ResolvedTarget,
  type TargetPreferences,
  type TargetSelection,
} from "@winston/contracts/connection-targets";

export type TargetCatalog = { connection: Connection; calendars: GoogleCalendar[] }[];
export type TargetResolution =
  | { status: "resolved"; target: ResolvedTarget }
  | { status: "unavailable" }
  | { status: "choose"; question: string; choices: ResolvedTarget[] };

export function sameTarget(first: ConnectionTarget, second: ConnectionTarget) {
  return first.connectionId === second.connectionId && first.calendarId === second.calendarId;
}

export function targetChoices(
  catalog: TargetCatalog,
  preferences: TargetPreferences,
  selection: TargetSelection,
): ResolvedTarget[] {
  const service = selection.operation.startsWith("gmail.") ? "gmail" : "calendar";
  return catalog.flatMap(({ connection, calendars }) => {
    if (connection.service !== service || !["connected", "limited"].includes(connection.status))
      return [];
    const ids =
      service === "gmail"
        ? [null]
        : calendars
            .filter(
              (calendar) =>
                !calendar.deleted &&
                connection.calendars.includes(calendar.id) &&
                (selection.operation === "calendar.write"
                  ? ["writer", "writerWithoutPrivateAccess", "owner"].includes(calendar.accessRole)
                  : calendar.accessRole !== "freeBusyReader"),
            )
            .map((calendar) => calendar.id);
    return ids.map((calendarId) => {
      const target = { connectionId: connection.id, calendarId };
      const accountLabel =
        preferences.labels.find((entry) =>
          sameTarget(entry.target, { connectionId: connection.id, calendarId: null }),
        )?.label ?? connection.email;
      const calendar = calendars.find((entry) => entry.id === calendarId);
      const calendarLabel =
        preferences.labels.find((entry) => sameTarget(entry.target, target))?.label ??
        calendar?.summaryOverride ??
        calendar?.summary ??
        calendarId;
      return {
        ...target,
        operation: selection.operation,
        connectionRevision: connection.revision,
        preferencesRevision: preferences.revision,
        ...(selection.task ? { task: selection.task } : {}),
        email: connection.email,
        label:
          calendarId === null ? accountLabel : `${accountLabel} · ${calendarLabel ?? calendarId}`,
      };
    });
  });
}

// A binding comes from the owner-scoped task store, never from search results or model text.
export function resolveConnectionTarget(
  catalog: TargetCatalog,
  preferences: TargetPreferences,
  input: TargetSelection,
  binding?: ConnectionTarget,
): TargetResolution {
  const selection = targetSelectionSchema.parse(input);
  const choices = targetChoices(catalog, preferences, selection);
  const requested =
    selection.explicit ??
    binding ??
    preferences.defaults.find((entry) => entry.operation === selection.operation)?.target;
  if (requested) {
    const target = choices.find((choice) => sameTarget(choice, requested));
    // An unavailable explicit/bound/default target must never fall through to another account.
    return target ? { status: "resolved", target } : { status: "unavailable" };
  }
  const only = choices[0];
  if (choices.length === 1 && only) return { status: "resolved", target: only };
  if (choices.length === 0) return { status: "unavailable" };
  return {
    status: "choose",
    question:
      selection.operation === "gmail.send"
        ? "Which account should send this?"
        : selection.operation === "calendar.write"
          ? "Which calendar should I use?"
          : "Which account or calendar should I use?",
    choices,
  };
}

// Approval code must also bind the concrete action arguments. This only compares its target context.
export function sameResolvedTarget(first: ResolvedTarget, second: ResolvedTarget) {
  return (
    sameTarget(first, second) &&
    first.operation === second.operation &&
    first.connectionRevision === second.connectionRevision &&
    first.preferencesRevision === second.preferencesRevision &&
    first.task?.id === second.task?.id &&
    first.task?.revision === second.task?.revision
  );
}

export function labelSearchResults<T>(source: ResolvedTarget, results: T[]) {
  return results.map((result) => ({ source, result }));
}
