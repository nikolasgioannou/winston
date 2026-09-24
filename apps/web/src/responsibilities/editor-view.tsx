import { useState } from "react";
import { Button, TextArea } from "@winston/ui";
import {
  ownerResponsibilityEditSchema,
  type Responsibility,
} from "@winston/contracts/responsibilities";
import { ResponsibilityScope, type ScopeNames } from "./scope";

export type ResponsibilityEdit = ReturnType<typeof ownerResponsibilityEditSchema.parse>;
export function ResponsibilityEditorView({
  item,
  names,
  busy,
  failed,
  onSave,
  onCancel,
  onReload,
}: {
  item: Responsibility;
  names: ScopeNames;
  busy: boolean;
  failed: boolean;
  onSave: (input: ResponsibilityEdit) => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const [original] = useState(item);
  const [purpose, setPurpose] = useState(item.purpose);
  const [scope, setScope] = useState(item.scope);
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <h1 className="text-xl font-medium">Edit responsibility</h1>
      {failed ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-muted">
            Could not confirm the change. Reload before making another change.
          </p>
          <Button disabled={busy} onClick={onReload}>
            Reload responsibility
          </Button>
        </div>
      ) : null}
      <form
        className="max-w-lg space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || failed || item.state === "ended") return;
          const result = ownerResponsibilityEditSchema.safeParse({
            revision: original.revision,
            purpose,
            scope,
          });
          setInvalid(!result.success);
          if (result.success) onSave(result.data);
        }}
      >
        <TextArea
          label="Purpose"
          rows={4}
          maxLength={4000}
          value={purpose}
          disabled={busy || item.state === "ended"}
          onChange={(event) => {
            setPurpose(event.target.value);
          }}
        />
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Scope</h2>
          {scope.map((entry, index) => (
            <div key={JSON.stringify(entry)} className="space-y-1">
              <ResponsibilityScope scope={[entry]} names={names} />
              <Button
                variant="quiet"
                disabled={busy || failed}
                aria-label={`Remove scope item ${String(index + 1)}`}
                onClick={() => {
                  setScope((current) => current.filter((candidate) => candidate !== entry));
                }}
              >
                Remove
              </Button>
            </div>
          ))}
          {!scope.length ? (
            <p className="text-sm text-muted">No connected accounts or computers.</p>
          ) : null}
          {scope.length < original.scope.length ? (
            <Button
              variant="quiet"
              disabled={busy || failed}
              onClick={() => {
                setScope(original.scope);
              }}
            >
              Restore scope
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted">
          Saving requires a new agreement and cancels existing schedules.
        </p>
        {invalid ? (
          <p role="alert" className="text-sm text-muted">
            Enter a purpose for Winston.
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={busy || failed || !purpose.trim() || item.state === "ended"}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
          <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </>
  );
}
