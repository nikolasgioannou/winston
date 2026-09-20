import type { ComponentProps } from "react";

export function SidebarLink({ className = "", children, ...props }: ComponentProps<"a">) {
  return (
    <a
      {...props}
      className={`flex h-7.5 items-center gap-2 rounded-md px-2 text-sm/5.25
        text-muted transition-colors duration-100 hover:bg-hover
        aria-[current=page]:bg-selected aria-[current=page]:text-ink
        aria-[current=page]:hover:bg-selected-hover motion-reduce:transition-none ${className}`}
    >
      {children}
    </a>
  );
}
