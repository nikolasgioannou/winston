import type { Responsibility } from "@winston/contracts/responsibilities";
import type { AuthorizationRequest } from "@winston/contracts/authorization";

const operations: Record<AuthorizationRequest["operation"], string> = {
  "gmail.read": "Read email",
  "gmail.draft": "Create email drafts",
  "gmail.send": "Send email",
  "gmail.modify": "Change email",
  "calendar.list": "List calendars",
  "calendar.read": "Read calendar",
  "calendar.write": "Change calendar",
  "device.command": "Run commands",
  "device.file.read": "Read files",
  "device.file.write": "Change files",
  "device.observe": "Observe screen",
  "device.input": "Use keyboard and mouse",
  "device.application": "Control applications",
  "workspace.command": "Run commands",
  "workspace.file.read": "Read files",
  "workspace.file.write": "Change files",
};
export type ScopeNames = Record<string, string>;

export function ResponsibilityScope({
  scope,
  names,
}: {
  scope: Responsibility["scope"];
  names: ScopeNames;
}) {
  if (!scope.length)
    return <p className="text-sm text-muted">No connected accounts or computers.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {scope.map(({ target, operation }) => (
        <li
          key={`${target.kind}:${target.id}:${target.resource ?? ""}:${operation}`}
          className="space-y-0.5 wrap-anywhere"
        >
          <p>
            {operations[operation]} ·{" "}
            {names[`${target.kind}:${target.id}`] ??
              (target.kind === "workspace"
                ? "Winston’s computer"
                : "Unavailable account or computer")}
          </p>
          {target.resource ? <p className="text-xs text-muted">{target.resource}</p> : null}
          {target.kind === "workspace" || !names[`${target.kind}:${target.id}`] ? (
            <p className="text-xs text-muted">{target.id}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
