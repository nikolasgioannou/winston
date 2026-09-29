import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { designPages } from "../-pages";

// One page state, alone, for the dev design view's iframe: the frame's own
// viewport is what makes the page's responsive behavior real.
export const Route = createFileRoute("/dev/design/frame")({
  validateSearch: z.object({
    page: z.string(),
    state: z.string(),
    theme: z.enum(["light", "dark"]).default("light"),
  }),
  component: Frame,
});

function Frame() {
  const { page, state, theme } = Route.useSearch();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const fixture = designPages[page]?.states[state];
  if (!fixture)
    return (
      <p className="p-6 text-sm text-fg-muted">
        No state “{state}” for page “{page}”.
      </p>
    );
  return <>{fixture.render()}</>;
}
