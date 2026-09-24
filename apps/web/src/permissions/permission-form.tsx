import { useState } from "react";
import { Button, Select } from "@winston/ui";
import type {
  AuthorizationRequest,
  AuthorizationRules,
  AuthorizationUpdate,
} from "@winston/contracts/authorization";

export function PermissionForm({
  request,
  rules,
  unavailable,
  disabled,
  onSave,
}: {
  request: AuthorizationRequest;
  rules: AuthorizationRules;
  unavailable: boolean;
  disabled: boolean;
  onSave: (update: AuthorizationUpdate) => void;
}) {
  const [original] = useState(rules);
  const matches = original.rules.filter(
    (rule) =>
      rule.operation === request.operation &&
      rule.target.kind === request.target.kind &&
      rule.target.id === request.target.id,
  );
  const parent = matches.find((rule) => rule.target.resource === null);
  const exact = matches.find((rule) => rule.target.resource === request.target.resource);
  const inheritedDeny = request.target.resource !== null && parent?.decision === "deny";
  const initial = inheritedDeny
    ? "deny"
    : (exact?.decision ??
      parent?.decision ??
      (request.target.kind === "workspace" ? "allow" : "ask"));
  const [decision, setDecision] = useState<AuthorizationUpdate["decision"]>(initial);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || inheritedDeny || (unavailable && decision === "allow")) return;
        onSave({ ...request, decision, revision: original.revision });
      }}
    >
      <Select
        label="Permission"
        value={decision}
        disabled={disabled || inheritedDeny}
        options={[
          { value: "ask", label: "Ask each time" },
          { value: "allow", label: "Allow" },
          { value: "deny", label: "Deny" },
        ]}
        onValueChange={(value) => {
          if (value === "ask" || value === "allow" || value === "deny") setDecision(value);
        }}
      />
      {inheritedDeny ? (
        <p className="text-sm text-muted">
          This account denies this action for all calendars. Change the account permission first.
        </p>
      ) : null}
      {unavailable ? (
        <p className="text-sm text-muted">
          This account or computer is unavailable. It must be available before you can allow access.
        </p>
      ) : null}
      {request.operation === "device.command" ? (
        <p className="text-sm text-muted">
          Commands can access files and applications on this computer. File-specific permissions do
          not limit commands.
        </p>
      ) : null}
      {request.target.kind === "connection" &&
      request.target.resource === null &&
      request.operation.startsWith("calendar.") &&
      request.operation !== "calendar.list" ? (
        <p className="text-sm text-muted">
          Applies to all selected calendars in this account unless a calendar has its own rule. Deny
          overrides every calendar rule.
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={disabled || inheritedDeny || (unavailable && decision === "allow")}
      >
        Save permission
      </Button>
    </form>
  );
}
