import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { cn } from "./cn";

/**
 * A square ghost button holding just an icon (e.g. ⋯ for more actions). It
 * has no text, so `label` names it for screen readers.
 */
export function IconButton({
  label,
  children,
  size = "md",
  className,
  ...props
}: Omit<ButtonProps, "children" | "variant"> & {
  label: string;
  /** A 16px icon. */
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={label}
      className={cn(
        "px-0 text-icon [&>svg]:size-4",
        size === "sm" ? "w-7" : "w-8",
        className,
      )}
      {...props}
    >
      {children}
    </Button>
  );
}
