import { useState } from "react";
import type { TaskDetail } from "@winston/contracts/tasks";
import { Button } from "@winston/ui";

export function CancelRequest({
  task,
  busy,
  failed,
  onCancel,
}: {
  task: TaskDetail;
  busy: boolean;
  failed: boolean;
  onCancel: (revision: number) => void;
}) {
  const [confirm, setConfirm] = useState<TaskDetail | null>(null);
  if (["canceled", "succeeded", "failed"].includes(task.state)) return null;
  return (
    <div className="space-y-3">
      {failed ? (
        <p role="alert" className="text-sm text-muted">
          Unable to confirm cancellation. Refresh before trying again.
        </p>
      ) : null}
      {confirm ? (
        <>
          <p className="text-sm">Stop this request? Actions already sent may still finish.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || failed}
              onClick={() => {
                onCancel(confirm.revision);
              }}
            >
              Stop request
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
              }}
            >
              Keep working
            </Button>
          </div>
        </>
      ) : (
        <Button
          variant="quiet"
          disabled={busy || failed}
          onClick={() => {
            setConfirm(task);
          }}
        >
          Cancel request
        </Button>
      )}
    </div>
  );
}
