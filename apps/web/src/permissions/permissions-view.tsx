import { useState } from "react";
import { Button, Select } from "@winston/ui";
import type {
  AuthorizationRequest,
  AuthorizationRules,
  AuthorizationUpdate,
} from "@winston/contracts/authorization";
import type { ScopeChoice } from "../management/resource-options";
import { operationLabels } from "../management/operation-labels";
import { PermissionForm } from "./permission-form";

export type PermissionsState =
  | { kind: "loading" | "error" }
  | { kind: "ready"; choices: ScopeChoice[]; rules: AuthorizationRules };

export function PermissionsView({
  state,
  busy = false,
  failed = false,
  more = false,
  onRefresh,
  onMore,
  onSave,
  version = 0,
  initialSelection,
}: {
  state: PermissionsState;
  busy?: boolean;
  failed?: boolean;
  more?: boolean;
  onRefresh: () => void;
  onMore: () => void;
  onSave: (input: AuthorizationUpdate) => void;
  version?: number;
  initialSelection?: AuthorizationRequest;
}) {
  const [target, setTarget] = useState<string | null>(
    initialSelection ? JSON.stringify(initialSelection.target) : null,
  );
  const [operation, setOperation] = useState<string | null>(initialSelection?.operation ?? null);
  const selected =
    state.kind === "ready"
      ? state.choices.find((choice) => JSON.stringify(choice.target) === target)
      : undefined;
  const action = selected?.operations.find((item) => item === operation);
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-medium">Permissions</h1>
        <Button variant="quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {state.kind === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Loading permissions…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-sm text-muted">
          Unable to load permissions. Refresh to try again.
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-muted">
          Could not confirm the change. Refresh before making another change.
        </p>
      ) : null}
      {state.kind === "ready" ? (
        state.choices.length ? (
          <div className="max-w-lg space-y-5">
            <Select
              label="Account or computer"
              value={target}
              disabled={busy || failed}
              options={state.choices.map((choice) => ({
                value: JSON.stringify(choice.target),
                label: choice.label,
              }))}
              onValueChange={(value) => {
                setTarget(value);
                setOperation(null);
              }}
            />
            {selected ? (
              <Select
                label="Action"
                value={operation}
                disabled={busy || failed}
                options={selected.operations.map((item) => ({
                  value: item,
                  label: operationLabels[item],
                }))}
                onValueChange={setOperation}
              />
            ) : null}
            {selected && action ? (
              <PermissionForm
                key={`${target ?? ""}:${action}:${String(version)}`}
                request={{ target: selected.target, operation: action }}
                rules={state.rules}
                unavailable={selected.unavailable}
                disabled={busy || failed}
                onSave={onSave}
              />
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">No connected accounts or computers.</p>
        )
      ) : null}
      {more ? (
        <Button disabled={busy || failed} onClick={onMore}>
          More computers
        </Button>
      ) : null}
    </>
  );
}
