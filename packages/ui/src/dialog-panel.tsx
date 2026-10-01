import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

/**
 * A dialog for working with something without leaving the page (adding an
 * account, managing one): Notion's panel, with a title, a close button and
 * a body that scrolls when it's tall. Open it from `trigger`, or control it
 * with `open` and `onOpenChange` (e.g. from the URL).
 */
export function Dialog({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
  defaultOpen,
  className,
}: {
  /** The button that opens it. */
  trigger?: ReactElement;
  title: ReactNode;
  /** A line under the title, when it adds something. */
  description?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Starts open, e.g. to show it in the dev design view. */
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <BaseDialog.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen ? { defaultOpen } : {})}
      {...(onOpenChange
        ? {
            onOpenChange: (next) => {
              onOpenChange(next);
            },
          }
        : {})}
    >
      {trigger && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 bg-backdrop transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <BaseDialog.Popup
          className={cn(
            "fixed top-1/2 left-1/2 flex max-h-[calc(100dvh-32px)] w-[min(520px,calc(100vw-32px))] -translate-1/2 flex-col rounded-xl bg-surface-raised text-fg shadow-dialog transition-[opacity,scale] duration-200 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
        >
          <div className="flex items-start gap-4 px-6 pt-5 pb-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <BaseDialog.Title className="text-base font-semibold wrap-break-word">
                {title}
              </BaseDialog.Title>
              {description !== undefined && (
                <BaseDialog.Description className="text-sm text-fg-muted">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close
              aria-label="Close"
              className="-mt-0.5 -mr-2 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-icon transition-[background-color] duration-100 outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)]"
            >
              <X className="size-4" />
            </BaseDialog.Close>
          </div>
          <div className="flex flex-col gap-6 overflow-y-auto px-6 pb-6">
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
