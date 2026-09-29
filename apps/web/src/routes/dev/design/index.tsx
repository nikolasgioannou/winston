import { createFileRoute, Link } from "@tanstack/react-router";
import { Badge, Select, Sidebar, SidebarGroup, SidebarItem } from "@winston/ui";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { designPages, firstPage } from "../-pages";

/** The frames' sizes: a laptop and a phone. */
const frames = {
  desktop: { width: 1280, height: 800, label: "Desktop (1280px)" },
  mobile: { width: 375, height: 812, label: "Mobile (375px)" },
} as const;

// Every page in every state, at desktop or mobile width, in light or dark
// (docs/design.md §20). Development only: production builds leave out
// src/routes/dev (vite.config.ts). The choices live in the URL, so a reload
// keeps them.
export const Route = createFileRoute("/dev/design/")({
  validateSearch: z.object({
    page: z.string().default(firstPage),
    state: z.string().optional(),
    frame: z.enum(["desktop", "mobile"]).default("desktop"),
    theme: z.enum(["light", "dark"]).default("light"),
  }),
  component: DesignView,
});

function DesignView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const page = designPages[search.page] ?? designPages[firstPage];
  const stateIds = page ? Object.keys(page.states) : [];
  const state =
    search.state && stateIds.includes(search.state)
      ? search.state
      : (stateIds[0] ?? "");

  // The toggle themes the view itself as well as the frame.
  useEffect(() => {
    document.documentElement.dataset.theme = search.theme;
  }, [search.theme]);

  const set = (next: Partial<typeof search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }) });

  return (
    <div className="flex h-screen bg-surface text-fg">
      <Sidebar>
        <SidebarGroup label="Pages">
          {Object.entries(designPages).map(([id, fixtures]) => (
            <SidebarItem
              key={id}
              icon={<span className="size-1.5 rounded-full bg-icon" />}
              selected={id === search.page}
              render={
                <Link
                  to="/dev/design"
                  search={(prev) => ({ ...prev, page: id, state: undefined })}
                />
              }
            >
              {fixtures.title}
            </SidebarItem>
          ))}
        </SidebarGroup>
      </Sidebar>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-6 py-3">
          <div className="mr-auto flex items-center gap-2">
            <span className="text-sm font-medium">{page?.title}</span>
            {page && <Badge>{page.path}</Badge>}
          </div>
          <Select
            aria-label="State"
            value={state}
            onValueChange={(value) => {
              set({ state: value });
            }}
            options={stateIds.map((id) => ({
              value: id,
              label: page?.states[id]?.label ?? id,
            }))}
          />
          <Select
            aria-label="Frame"
            value={search.frame}
            onValueChange={(value) => {
              set({ frame: value });
            }}
            options={[
              { value: "desktop", label: frames.desktop.label },
              { value: "mobile", label: frames.mobile.label },
            ]}
          />
          <Select
            aria-label="Theme"
            value={search.theme}
            onValueChange={(value) => {
              set({ theme: value });
            }}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </header>
        <FrameArea
          src={`/dev/design/frame?${new URLSearchParams({
            page: search.page,
            state,
            theme: search.theme,
          }).toString()}`}
          size={frames[search.frame]}
        />
      </main>
    </div>
  );
}

/** The iframe at its real size, scaled down to fit when it's wider than the space. */
function FrameArea({
  src,
  size,
}: {
  src: string;
  size: { width: number; height: number };
}) {
  const area = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setScale(Math.min(1, width / size.width, height / size.height));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [size.width, size.height]);

  return (
    <div
      ref={area}
      className="flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-surface-sunken p-6"
    >
      <div style={{ width: size.width * scale, height: size.height * scale }}>
        <iframe
          title="Page preview"
          src={src}
          style={{
            width: size.width,
            height: size.height,
            transform: `scale(${String(scale)})`,
            transformOrigin: "top left",
          }}
          className="bg-surface shadow-md"
        />
      </div>
    </div>
  );
}
