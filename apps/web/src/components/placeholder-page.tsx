import type { ReactNode } from "react";

/** A page that exists in the navigation but isn't built yet. */
export function PlaceholderPage({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2 px-6 py-8 sm:px-10">
      <h1 className="text-title font-semibold">{title}</h1>
      <p className="text-sm text-fg-muted">
        {children ?? "This page is coming in a later update."}
      </p>
    </div>
  );
}
