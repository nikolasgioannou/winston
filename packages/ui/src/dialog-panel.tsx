import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

/** One tab of a `Dialog`: its label in the header, its content in the body. */
export interface DialogTab {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * A dialog for working with something without leaving the page (adding an
 * account, managing one): Notion's panel, with a header (title, subtitle,
 * close button) divided from a body that scrolls when it's tall. With `tabs`,
 * the tab list sits at the bottom of the header and each tab's content fills
 * the body; `children` then show above every tab. It hangs from a fixed
 * distance below the top, so switching to a shorter tab doesn't make it jump.
 * Open it from `trigger`, or
 * control it with `open` and `onOpenChange` (e.g. from the URL).
 */
export function Dialog({
  trigger,
  title,
  description,
  children,
  tabs,
  defaultTab,
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
  children?: ReactNode;
  tabs?: readonly DialogTab[];
  /** The tab shown first (the first tab by default). */
  defaultTab?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Starts open, e.g. to show it in the dev design view. */
  defaultOpen?: boolean;
  className?: string;
}) {
  const header = (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border-subtle px-6 pt-5",
        tabs ? "" : "pb-4",
      )}
    >
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <BaseDialog.Title className="text-base font-semibold wrap-break-word">
            {title}
          </BaseDialog.Title>
          {description !== undefined && (
            <BaseDialog.Description
              render={<div />}
              className="text-sm text-fg-muted"
            >
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
      {tabs && (
        // The indicator sits on the header's divider.
        <Tabs.List className="relative -mb-px flex gap-5">
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.value}
              value={tab.value}
              className="cursor-pointer pb-2.5 text-sm font-medium text-fg-muted transition-colors duration-100 outline-none hover:text-fg focus-visible:text-fg data-active:text-fg"
            >
              {tab.label}
            </Tabs.Tab>
          ))}
          <Tabs.Indicator className="absolute bottom-0 left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-fg transition-[left,width] duration-200 ease-out" />
        </Tabs.List>
      )}
    </div>
  );
  const body = (
    <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 py-5">
      {children}
      {tabs?.map((tab) => (
        <Tabs.Panel
          key={tab.value}
          value={tab.value}
          className="flex flex-col gap-6 outline-none"
        >
          {tab.content}
        </Tabs.Panel>
      ))}
    </div>
  );

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
            "fixed top-[min(12dvh,96px)] left-1/2 flex max-h-[calc(100dvh-min(12dvh,96px)-16px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-xl bg-surface-raised text-fg shadow-dialog transition-[opacity,scale] duration-200 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
        >
          {tabs ? (
            <Tabs.Root
              defaultValue={defaultTab ?? tabs[0]?.value}
              className="flex min-h-0 flex-1 flex-col"
            >
              {header}
              {body}
            </Tabs.Root>
          ) : (
            <>
              {header}
              {body}
            </>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
