import { useState } from "react";
import type { AuthorizationRules } from "@winston/contracts/authorization";
import { PermissionsView, type PermissionsState } from "../permissions/permissions-view";
import { ManagementShell } from "../management/shell";

export function PermissionsPreview({
  initial,
}: {
  initial: "ready" | "empty" | "loading" | "error" | "saving" | "uncertain" | "unavailable";
}) {
  const target = {
    kind: "device" as const,
    id: "11111111-1111-4111-8111-111111111111",
    resource: null,
  };
  const [rules, setRules] = useState<AuthorizationRules>({ revision: 0, rules: [] });
  const [kind, setKind] = useState<PermissionsState["kind"]>(
    initial === "loading" || initial === "error" ? initial : "ready",
  );
  const [failed, setFailed] = useState(initial === "uncertain");
  const [version, setVersion] = useState(0);
  return (
    <ManagementShell preview activeHref="/permissions" onNavigate={() => {}}>
      <PermissionsView
        version={version}
        initialSelection={{ target, operation: "device.command" }}
        state={
          kind === "ready"
            ? {
                kind,
                rules,
                choices:
                  initial === "empty"
                    ? []
                    : [
                        {
                          label: "Studio Mac",
                          target,
                          operations: ["device.command", "device.file.read"],
                          unavailable: initial === "unavailable",
                        },
                      ],
              }
            : { kind }
        }
        busy={initial === "saving"}
        failed={failed}
        onMore={() => {}}
        onRefresh={() => {
          setKind("ready");
          setFailed(false);
          setVersion((value) => value + 1);
        }}
        onSave={({ revision, ...rule }) => {
          setRules({ revision: revision + 1, rules: [rule] });
          setVersion((value) => value + 1);
        }}
      />
    </ManagementShell>
  );
}
