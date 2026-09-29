import { CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/** What a page or list shows when there's nothing in it yet. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  /** A 24px icon, e.g. from lucide-react. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {icon !== undefined && (
        <span className="text-icon [&>svg]:size-6">{icon}</span>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <span className="text-base font-medium text-fg">{title}</span>
        {description !== undefined && (
          <span className="text-sm text-fg-muted">{description}</span>
        )}
      </div>
      {action !== undefined && <div className="pt-1">{action}</div>}
    </div>
  );
}

/** What a page or section shows when loading it failed, with a way to try again. */
export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Usually a "Try again" button. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <EmptyState
      icon={<CircleX className="text-error-text" />}
      title={title}
      description={description}
      action={action}
      className={className}
    />
  );
}
