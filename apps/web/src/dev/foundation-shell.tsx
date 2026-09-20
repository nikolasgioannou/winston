import { useState } from "react";
import { Activity, Link, Monitor, Sidebar } from "@winston/ui";
import { ComponentGallery } from "./component-gallery";

export function FoundationShell() {
  const [section, setSection] = useState<"controls" | "feedback" | "layout">("controls");

  return (
    <Sidebar
      persistWidth={false}
      items={[
        { label: "Controls", href: "#controls", icon: Link },
        { label: "Feedback", href: "#feedback", icon: Activity },
        { label: "Data & layout", href: "#layout", icon: Monitor },
      ]}
      activeHref={`#${section}`}
      onNavigate={(href) => {
        setSection(href === "#feedback" ? "feedback" : href === "#layout" ? "layout" : "controls");
      }}
    >
      <main className="p-5 pt-20 md:p-10">
        <ComponentGallery key={section} section={section} />
      </main>
    </Sidebar>
  );
}
