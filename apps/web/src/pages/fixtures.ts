import type { ReactNode } from "react";

/**
 * A page's states for the dev design view (docs/design.md §20): each renders
 * the real page component with fixture data, no network. Only the view
 * imports fixtures, so production builds leave them out.
 */
export interface PageFixtures {
  title: string;
  /** The page's real path, shown for reference. */
  path: string;
  states: Record<string, { label: string; render: () => ReactNode }>;
}
