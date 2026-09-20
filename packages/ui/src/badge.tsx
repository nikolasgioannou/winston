import type { ReactNode } from "react";

const tones = {
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
  neutral: "text-muted",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof tones;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tones[tone]}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}
