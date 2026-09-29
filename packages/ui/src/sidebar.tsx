import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "./cn";

/**
 * Notion's sidebar widths: it starts at its minimum and only grows. The
 * maximum is provisional until measured.
 */
export const sidebarWidth = { default: 270, min: 270, max: 480 } as const;

const keyboardStep = 16;

export interface SidebarProps {
  children: ReactNode;
  /** The starting width, e.g. one the user chose before. */
  defaultWidth?: number;
  /** Called when a resize ends, with the new width. */
  onWidthChange?: (width: number) => void;
  className?: string;
}

/**
 * The app's navigation column, like Notion's: a warm gray panel with a
 * hairline right edge, resizable by dragging that edge or, when the handle
 * is focused, with the arrow keys.
 */
export function Sidebar({
  children,
  defaultWidth = sidebarWidth.default,
  onWidthChange,
  className,
}: SidebarProps) {
  const [width, setWidth] = useState(clamp(defaultWidth));
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setResizing(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(
      clamp(drag.current.startWidth + event.clientX - drag.current.startX),
    );
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setResizing(false);
    onWidthChange?.(width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? width - keyboardStep
        : event.key === "ArrowRight"
          ? width + keyboardStep
          : event.key === "Home"
            ? sidebarWidth.min
            : event.key === "End"
              ? sidebarWidth.max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const clamped = clamp(next);
    setWidth(clamped);
    onWidthChange?.(clamped);
  };

  return (
    <aside
      style={{ width }}
      className={cn(
        "relative flex shrink-0 flex-col bg-surface-sunken shadow-[inset_-1px_0_0_0_var(--w-sidebar-edge)]",
        resizing && "select-none",
        className,
      )}
    >
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {children}
      </nav>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={sidebarWidth.min}
        aria-valuemax={sidebarWidth.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cn(
          "group absolute inset-y-0 -right-3 z-10 w-3 cursor-col-resize outline-none",
        )}
      >
        {/* Like Notion's: drawn over the sidebar's edge, growing inward, with no fade. */}
        <div
          className={cn(
            "absolute inset-y-0 right-full w-0.5 group-hover:bg-sidebar-resize group-focus-visible:bg-focus",
            resizing && "bg-sidebar-resize",
          )}
        />
      </div>
    </aside>
  );
}

function clamp(width: number) {
  return Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, width));
}

/** A label above a group of sidebar items. */
export function SidebarGroup({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 pt-3 first:pt-0">
      <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">
        {label}
      </div>
      {children}
    </div>
  );
}

export interface SidebarItemProps extends useRender.ComponentProps<"a"> {
  /** A 16px icon, e.g. from lucide-react. */
  icon: ReactNode;
  selected?: boolean;
}

/**
 * A sidebar row: Notion's 16px icon in a 22px box, a 14px medium label, and
 * the hover wash. Renders a link by default; pass `render` for a router link.
 */
export function SidebarItem({
  icon,
  selected = false,
  render,
  className,
  children,
  ...props
}: SidebarItemProps) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        "aria-current": selected ? "page" : undefined,
        className: cn(
          "flex h-7.5 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--w-focus)]",
          selected
            ? "bg-hover text-fg"
            : "text-fg-secondary transition-[background-color] duration-100 ease-in-out hover:bg-hover",
          typeof className === "string" ? className : undefined,
        ),
        children: (
          <>
            <span className="flex size-5.5 shrink-0 items-center justify-center text-icon [&>svg]:size-4">
              {icon}
            </span>
            <span className="truncate">{children}</span>
          </>
        ),
      },
      props,
    ),
  });
}
