import { useState } from "react";
import { Button, Select } from "@winston/ui";
import type { AuthorizationRequest } from "@winston/contracts/authorization";
import type { ScopeCatalog } from "./scope-options";
import { scopeOperationLabels } from "./scope";

export function ScopePicker({
  catalog,
  scope,
  disabled,
  more,
  onMore,
  onRetry,
  onAdd,
}: {
  catalog: ScopeCatalog;
  scope: AuthorizationRequest[];
  disabled: boolean;
  more: boolean;
  onMore: () => void;
  onRetry: () => void;
  onAdd: (item: AuthorizationRequest) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  if (catalog.kind !== "ready")
    return (
      <div className="space-y-2">
        <p role={catalog.kind === "error" ? "alert" : "status"} className="text-sm text-muted">
          {catalog.kind === "error"
            ? "Unable to load available accounts and computers."
            : "Loading available accounts and computers…"}
        </p>
        {catalog.kind === "error" ? (
          <Button type="button" disabled={disabled} onClick={onRetry}>
            Reload choices
          </Button>
        ) : null}
      </div>
    );
  if (!catalog.items.length)
    return <p className="text-sm text-muted">No accounts or computers available.</p>;
  const selected = catalog.items.find((item) => JSON.stringify(item.target) === target);
  const selectedOperation = selected?.operations.find((item) => item === operation);
  const duplicate = scope.some(
    (item) => JSON.stringify(item.target) === target && item.operation === operation,
  );
  return (
    <div className="space-y-3">
      <Select
        label="Account or computer"
        disabled={disabled}
        options={catalog.items.map((item) => ({
          value: JSON.stringify(item.target),
          label: item.label,
        }))}
        value={target}
        onValueChange={(value) => {
          setTarget(value);
          setOperation(null);
        }}
      />
      {selected ? (
        <Select
          label="Action"
          disabled={disabled || selected.unavailable}
          options={selected.operations.map((value) => ({
            value,
            label: scopeOperationLabels[value],
          }))}
          value={operation}
          onValueChange={setOperation}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={
            disabled ||
            !selected ||
            selected.unavailable ||
            !selectedOperation ||
            duplicate ||
            scope.length >= 100
          }
          onClick={() => {
            if (
              selected &&
              !selected.unavailable &&
              selectedOperation &&
              !duplicate &&
              scope.length < 100
            ) {
              onAdd({ target: selected.target, operation: selectedOperation });
              setOperation(null);
            }
          }}
        >
          Add to scope
        </Button>
        {more ? (
          <Button type="button" variant="quiet" disabled={disabled} onClick={onMore}>
            More computers
          </Button>
        ) : null}
      </div>
    </div>
  );
}
