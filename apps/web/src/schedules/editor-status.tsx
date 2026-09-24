import { Button } from "@winston/ui";

export function EditorStatus({
  state,
  onRetry,
  onBack,
}: {
  state: "loading" | "error";
  onRetry: () => void;
  onBack: () => void;
}) {
  if (state === "loading")
    return (
      <p role="status" className="text-sm text-muted">
        Loading schedule…
      </p>
    );
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-medium">Edit schedule</h1>
      <p role="alert" className="text-sm text-muted">
        Unable to load this schedule.
      </p>
      <Button onClick={onRetry}>Try again</Button>
      <Button variant="quiet" onClick={onBack}>
        Back to schedules
      </Button>
    </div>
  );
}
