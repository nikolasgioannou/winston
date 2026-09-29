import { CircleAlert, CircleCheck, CircleX, Info, Loader } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import type { StatusTone } from "./status-pill";

const tones: Record<StatusTone, { box: string; icon: ReactNode }> = {
  ok: { box: "bg-ok-bg text-ok", icon: <CircleCheck /> },
  attention: { box: "bg-attention-bg text-attention", icon: <CircleAlert /> },
  error: { box: "bg-error-bg text-error", icon: <CircleX /> },
  pending: { box: "bg-pending-bg text-pending", icon: <Loader /> },
  neutral: { box: "bg-neutral-bg text-neutral", icon: <Info /> },
};

/**
 * A message that stays on the page, like Notion's callout block: a tinted
 * panel with an icon, e.g. "Your work account's access expires tomorrow."
 */
export function Callout({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: StatusTone;
  title?: ReactNode;
  children?: ReactNode;
  /** A button, aligned to the right. */
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon } = tones[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-lg p-3", box, className)}
    >
      <span className="flex h-5 shrink-0 items-center [&>svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
        {title !== undefined && <span className="font-medium">{title}</span>}
        {children !== undefined && <span>{children}</span>}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}
