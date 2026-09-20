import { Activity, Link, Monitor, Palette, Sidebar, SidebarLink } from "@winston/ui";
import { ComponentGallery } from "./component-gallery";

const rootPath = "/__dev/design";
const componentsPath = `${rootPath}/components`;
const pagesPath = `${rootPath}/pages`;
const sections = [
  { label: "Controls", href: `${componentsPath}?section=controls`, icon: Link },
  { label: "Feedback", href: `${componentsPath}?section=feedback`, icon: Activity },
  { label: "Data & layout", href: `${componentsPath}?section=layout`, icon: Monitor },
];
const categories = [
  { label: "Components", href: componentsPath, icon: Palette },
  { label: "Pages & states", href: pagesPath, icon: Monitor },
];

export function DesignReview() {
  const path = window.location.pathname;
  const section = new URLSearchParams(window.location.search).get("section");
  const selectedSection = section === "feedback" || section === "layout" ? section : "controls";
  const inComponents = path === componentsPath;
  const inPages = path === pagesPath;
  const nested = inComponents || inPages;
  const activeHref = inComponents ? `${componentsPath}?section=${selectedSection}` : path;
  const items = inComponents ? sections : inPages ? [] : categories;

  return (
    <Sidebar
      items={items}
      activeHref={activeHref}
      header={
        nested ? (
          <SidebarLink href={rootPath}>
            <span aria-hidden="true">←</span>All reviews
          </SidebarLink>
        ) : undefined
      }
    >
      <main className="mx-auto max-w-5xl px-5 pt-20 pb-12 md:px-10 md:pt-14">
        {inComponents ? (
          <ComponentGallery section={selectedSection} />
        ) : inPages ? (
          <PageReviewIndex />
        ) : (
          <div className="space-y-8">
            <header>
              <h1 className="text-3xl font-semibold tracking-tight">Design review</h1>
            </header>
            <div className="grid gap-4 sm:grid-cols-2">
              {categories.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-lg border border-line p-5 transition-colors hover:bg-hover"
                >
                  <h2 className="font-medium">{item.label}</h2>
                </a>
              ))}
            </div>
          </div>
        )}
      </main>
    </Sidebar>
  );
}

function PageReviewIndex() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Pages & states</h1>
      </header>
      <div className="rounded-lg border border-line px-6 py-10">
        <h2 className="font-medium">No application pages to review yet</h2>
      </div>
    </div>
  );
}
