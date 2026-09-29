import { Drawer } from "@base-ui/react/drawer";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

/**
 * The sidebar on small screens: a menu button that opens the same navigation
 * as a drawer from the left, dismissed by tapping outside or swiping left.
 */
export function SidebarDrawer({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  /** Controlled, e.g. to close the drawer after navigating. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Drawer.Root
      swipeDirection="left"
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <Drawer.Trigger
        render={<Button variant="ghost" aria-label="Open navigation" />}
      >
        <Menu size={18} strokeWidth={2} />
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 bg-backdrop opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-300 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0" />
        <Drawer.Viewport className="fixed inset-0 flex">
          <Drawer.Popup className="flex h-full w-[min(300px,85vw)] translate-x-(--drawer-swipe-movement-x) flex-col overflow-y-auto overscroll-contain bg-surface-sunken p-2 shadow-dialog transition-transform duration-300 ease-out outline-none data-ending-style:-translate-x-full data-starting-style:-translate-x-full data-swiping:select-none">
            <Drawer.Title className="sr-only">Navigation</Drawer.Title>
            <nav className="flex min-h-0 flex-1 flex-col gap-0.5">
              {children}
            </nav>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
