import { ChevronLeft } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./cn";

/**
 * A signed-in page's column: centred, one width, one rhythm between its
 * blocks, so every page sits the same way in the app shell.
 */
export function Page({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8 sm:px-10",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A page's title, with an optional way back above it (a ghost button around
 * the app's link, e.g. `<Link to="/accounts" />`) and an optional action
 * beside it (e.g. "Add account").
 */
export function PageHeader({
  title,
  back,
  action,
}: {
  title: ReactNode;
  back?: { label: string; link: ReactElement };
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {back && (
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={back.link}
          // Lines the chevron up with the title.
          className="-ml-2 w-fit"
        >
          <ChevronLeft className="size-4" />
          {back.label}
        </Button>
      )}
      <div className="flex items-center justify-between gap-6">
        <h1 className="min-w-0 text-title font-semibold wrap-break-word text-fg">
          {title}
        </h1>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </div>
    </header>
  );
}

/** A small square holding an icon, e.g. beside an account in a list. */
export function IconTile({
  children,
  className,
}: {
  /** A 16px icon. */
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-strong text-icon [&>svg]:size-4",
        className,
      )}
    >
      {children}
    </span>
  );
}
