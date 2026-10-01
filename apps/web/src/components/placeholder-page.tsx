import { Page, PageHeader } from "@winston/ui";
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
    <Page>
      <PageHeader title={title} />
      <p className="text-sm text-fg-muted">
        {children ?? "This page is coming in a later update."}
      </p>
    </Page>
  );
}
