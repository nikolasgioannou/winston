import { Dialog } from "@base-ui/react/dialog";
import { Menu, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "./button";
import { Icon } from "./icon";
import { Backdrop } from "./backdrop";
import { SidebarLink } from "./sidebar-link";

type NavigationItem = { label: string; href: string; icon: LucideIcon };

const minimumWidth = 270;
const storageKey = "winston.sidebar.width";

function clampWidth(width: number) {
  const maximum = Math.max(minimumWidth, Math.min(480, window.innerWidth - 360));

  return Math.round(Math.max(minimumWidth, Math.min(maximum, width)));
}

function readWidth() {
  try {
    const saved = Number(localStorage.getItem(storageKey));

    return Number.isFinite(saved) ? clampWidth(saved) : minimumWidth;
  } catch {
    return minimumWidth;
  }
}

export function Sidebar({
  items,
  activeHref,
  header,
  children,
  onNavigate,
}: {
  items: NavigationItem[];
  activeHref: string;
  header?: ReactNode;
  children: ReactNode;
  onNavigate?: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [width, setWidth] = useState(readWidth);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      // Resizing still works when the browser disallows persistent storage.
    }
  }, [width]);

  useEffect(() => {
    const resize = () => {
      setWidth((current) => clampWidth(current));
    };

    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
    };
  }, []);

  const navigation = (
    <>
      {header && <div className="mb-5 pr-8 md:pr-0">{header}</div>}
      <nav aria-label="Workspace" className="grid gap-0.5">
        {items.map((item) => (
          <SidebarLink
            key={item.href}
            href={item.href}
            onClick={() => {
              setOpen(false);
              onNavigate?.(item.href);
            }}
            aria-current={item.href === activeHref ? "page" : undefined}
          >
            <span className="grid size-5.5 shrink-0 place-items-center">
              <Icon icon={item.icon} size={20} />
            </span>
            {item.label}
          </SidebarLink>
        ))}
      </nav>
    </>
  );

  return (
    <div style={{ "--sidebar-width": `${String(width)}px` } as CSSProperties}>
      <aside
        id="workspace-sidebar"
        className="fixed inset-y-0 left-0 hidden w-(--sidebar-width) flex-col border-r border-line bg-sidebar px-2 py-5 md:flex"
      >
        {navigation}
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable separator implements the ARIA window splitter pattern. */}
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-controls="workspace-sidebar"
          aria-valuemin={minimumWidth}
          aria-valuemax={clampWidth(480)}
          aria-valuenow={width}
          tabIndex={0}
          className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none
            after:absolute after:inset-y-0 after:left-0.75 after:w-0.5 after:bg-line after:opacity-0
            hover:after:opacity-100 focus-visible:after:opacity-100 data-resizing:after:opacity-100"
          data-resizing={resizing || undefined}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              setWidth(clampWidth(event.clientX));
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onLostPointerCapture={() => {
            setResizing(false);
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              return;
            }

            event.preventDefault();
            const next =
              event.key === "Home"
                ? minimumWidth
                : event.key === "End"
                  ? 480
                  : width + (event.key === "ArrowRight" ? 16 : -16);

            setWidth(clampWidth(next));
          }}
        />
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      </aside>
      <div className="fixed top-3 left-4 z-30 md:hidden">
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger render={<Button iconOnly aria-label="Open navigation" />}>
            <Icon icon={Menu} />
          </Dialog.Trigger>
          <Dialog.Portal>
            <Backdrop />
            <Dialog.Popup
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[90vw] flex-col bg-sidebar px-2 py-6
                shadow-dialog transition-[opacity,translate] duration-160 ease-in-out
                data-starting-style:-translate-x-3 data-starting-style:opacity-0
                data-ending-style:-translate-x-3 data-ending-style:opacity-0 motion-reduce:transition-none"
            >
              <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
              <Dialog.Description className="sr-only">
                Choose a workspace section.
              </Dialog.Description>
              <Dialog.Close
                render={
                  <Button
                    iconOnly
                    variant="quiet"
                    aria-label="Close navigation"
                    className="absolute top-5 right-3"
                  />
                }
              >
                <Icon icon={X} />
              </Dialog.Close>
              {navigation}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <div className="min-w-0 md:ml-(--sidebar-width)">{children}</div>
    </div>
  );
}
