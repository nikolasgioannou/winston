import type { ReactNode } from "react";
import { Card } from "./card";
import { cn } from "./cn";
import { IconTile } from "./page";

/**
 * A titled group of settings: by default a heading with Notion's hairline
 * divider, or with `card`, the heading above and the settings in a card.
 */
export function Section({
  title,
  card = false,
  children,
  className,
}: {
  title: ReactNode;
  card?: boolean;
  children: ReactNode;
  className?: string;
}) {
  if (card)
    return (
      <section className={cn("flex flex-col gap-3", className)}>
        <h2 className="text-base font-medium text-fg">{title}</h2>
        <Card>{children}</Card>
      </section>
    );
  return (
    <section className={cn("flex flex-col", className)}>
      <h2 className="border-b border-border-subtle pb-3 text-base font-medium text-fg">
        {title}
      </h2>
      <div className="flex flex-col gap-5 pt-4">{children}</div>
    </section>
  );
}

/**
 * One setting: a label and description on the left (after an optional icon,
 * e.g. a brand mark), its control on the right.
 */
export function SettingRow({
  label,
  description,
  control,
  icon,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** A 16px icon, shown in an `IconTile`. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6", className)}>
      {icon !== undefined && <IconTile className="-mr-3">{icon}</IconTile>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        {description !== undefined && (
          <span className="text-caption text-fg-muted">{description}</span>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
