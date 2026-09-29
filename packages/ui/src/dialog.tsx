import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";
import { Button } from "./button";

/**
 * A confirmation before something destructive (Notion's dialog: 12px corners,
 * a deep shadow over a dark backdrop, opening with a quick scale).
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  trigger: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<span className="contents" />}>
        {trigger}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-backdrop transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 flex w-[min(400px,calc(100vw-32px))] -translate-1/2 flex-col gap-4 rounded-xl bg-surface-raised p-6 text-fg shadow-dialog transition-[opacity,scale] duration-200 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="text-base font-semibold">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-fg-muted">
              {description}
            </AlertDialog.Description>
          </div>
          <div className="flex justify-end gap-2">
            <AlertDialog.Close render={<Button variant="secondary" />}>
              Cancel
            </AlertDialog.Close>
            <AlertDialog.Close
              render={<Button variant="danger" onClick={onConfirm} />}
            >
              {confirmLabel}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
