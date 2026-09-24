import type { Responsibility } from "@winston/contracts/responsibilities";
import { operationLabels } from "../management/operation-labels";
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
            {operationLabels[operation]} ·{" "}
            {names[`${target.kind}:${target.id}`] ??
              (target.kind === "workspace"
                ? "Winston’s computer"
                : "Unavailable account or computer")}
          </p>
          {target.resource ? <p className="text-xs text-muted">{target.resource}</p> : null}
          {!names[`${target.kind}:${target.id}`] ? (
            <p className="text-xs text-muted">{target.id}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
