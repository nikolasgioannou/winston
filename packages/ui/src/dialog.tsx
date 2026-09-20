import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Backdrop } from "./backdrop";

export function Dialog({
  title,
  description,
  trigger,
  children,
}: {
  title: string;
  description?: string;
  trigger: string;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root>
      <BaseDialog.Trigger render={<Button />}>{trigger}</BaseDialog.Trigger>
      <BaseDialog.Portal>
        <Backdrop />
        <BaseDialog.Popup
          className="fixed top-1/2 left-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md
            -translate-1/2 overflow-auto rounded-xl bg-paper p-6 shadow-dialog
            transition-[opacity,scale] duration-160 ease-[cubic-bezier(0.2,0.8,0.2,1)]
            data-starting-style:scale-98 data-starting-style:opacity-0
            data-ending-style:scale-98 data-ending-style:opacity-0 motion-reduce:transition-none"
        >
          <div className="flex items-center justify-between gap-4">
            <BaseDialog.Title className="text-lg font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close
              render={<Button iconOnly variant="quiet" aria-label="Close dialog" />}
            >
              <X size={17} aria-hidden="true" />
            </BaseDialog.Close>
          </div>
          {description && (
            <BaseDialog.Description className="mt-2 text-muted">
              {description}
            </BaseDialog.Description>
          )}
          <div className="mt-6">{children}</div>
          <div className="mt-6 flex justify-end">
            <BaseDialog.Close render={<Button variant="primary" />}>Done</BaseDialog.Close>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
