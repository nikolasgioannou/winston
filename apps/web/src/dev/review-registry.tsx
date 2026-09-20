import type { ComponentType } from "react";
import { ComponentGallery } from "./component-gallery";
import { FoundationShell } from "./foundation-shell";

export type ReviewState = {
  id: string;
  label: string;
  render: ComponentType;
  fullWidth?: boolean;
};

export type ReviewPage = {
  id: string;
  label: string;
  kind: "foundation" | "page";
  states: readonly [ReviewState, ...ReviewState[]];
};

// Page registrations import real view components and supply local fixture adapters.
// Production data hooks and actions must stay outside those view components.
export const reviewPages: readonly ReviewPage[] = [
  {
    id: "foundation",
    label: "Component foundation",
    kind: "foundation",
    states: [
      { id: "navigation", label: "Navigation", render: FoundationShell, fullWidth: true },
      { id: "controls", label: "Controls", render: () => <ComponentGallery section="controls" /> },
      { id: "feedback", label: "Feedback", render: () => <ComponentGallery section="feedback" /> },
      { id: "layout", label: "Data & layout", render: () => <ComponentGallery section="layout" /> },
    ],
  },
];

export const reviewViewports = [
  { value: "desktop", label: "Desktop · 1280px", width: 1280 },
  { value: "mobile", label: "Mobile · 390px", width: 390 },
] as const;

export function readReviewSelection(search: string) {
  const query = new URLSearchParams(search);
  const page = reviewPages.find((item) => item.id === query.get("page"));
  const state = page?.states.find((item) => item.id === query.get("state")) ?? page?.states[0];
  const viewport =
    reviewViewports.find((item) => item.value === query.get("viewport")) ?? reviewViewports[0];

  return { page, state, viewport };
}

export function reviewLink(page: string, state: string, viewport = "desktop") {
  return `/__dev/design/pages?${new URLSearchParams({ page, state, viewport }).toString()}`;
}
