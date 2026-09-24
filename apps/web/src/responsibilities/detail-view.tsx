import { Button } from "@winston/ui";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { ResponsibilitiesView, type ResponsibilityAction } from "./responsibilities-view";
import { ResponsibilityEvidence, type EvidenceState, type Sources, type History } from "./evidence";
import { ResponsibilityEditorView, type ResponsibilityEdit } from "./editor-view";
import type { ScopeNames } from "./scope";

export function ResponsibilityDetailView({
  state,
  sources,
  history,
  names,
  namesReady,
  busy,
  failed,
  editing,
  more,
  onBack,
  onRefresh,
  onMore,
  onChange,
  onEdit,
  onSave,
}: {
  state: EvidenceState<Responsibility>;
  sources: EvidenceState<Sources>;
  history: EvidenceState<History>;
  names: ScopeNames;
  namesReady: boolean;
  busy: boolean;
  failed: boolean;
  editing: boolean;
  more: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onMore: () => void;
  onChange: (item: Responsibility, action: ResponsibilityAction) => void;
  onEdit: (value: boolean) => void;
  onSave: (input: ResponsibilityEdit) => void;
}) {
  if (editing && state.kind === "ready" && state.value.state !== "ended")
    return (
      <ResponsibilityEditorView
        item={state.value}
        names={names}
        busy={busy}
        failed={failed}
        onSave={onSave}
        onCancel={() => {
          onEdit(false);
        }}
        onReload={onRefresh}
      />
    );
  return (
    <>
      <Button variant="quiet" onClick={onBack}>
        Back to responsibilities
      </Button>
      <ResponsibilitiesView
        title="Responsibility"
        state={state.kind === "ready" ? { kind: "ready", items: [state.value] } : state}
        names={names}
        namesReady={namesReady}
        busy={busy}
        failure={failed}
        onRefresh={onRefresh}
        onMore={onMore}
        onChange={onChange}
        onEdit={() => {
          onEdit(true);
        }}
      />
      {state.kind === "ready" ? (
        <>
          <ResponsibilityEvidence
            sources={sources}
            history={history}
            names={names}
            more={more}
            busy={busy}
            onMore={onMore}
            onRetry={onRefresh}
          />
        </>
      ) : null}
    </>
  );
}
