import type { ReactNode } from "react";
import { CalendarDays, Link, Settings, Sidebar } from "@winston/ui";

export function ManagementShell({
  activeHref,
  onNavigate,
  children,
  preview = false,
}: {
  activeHref: string;
  onNavigate: (href: string) => void;
  children: ReactNode;
  preview?: boolean;
}) {
  return (
    <Sidebar
      persistWidth={!preview}
      items={[
        { label: "Account", href: "/", icon: Settings },
        { label: "Connections", href: "/connections", icon: Link },
        { label: "Schedules", href: "/schedules", icon: CalendarDays },
      ]}
      activeHref={activeHref}
      onNavigate={onNavigate}
    >
      <main className="min-h-dvh bg-paper px-6 pt-20 pb-10 text-ink md:px-10 md:pt-10">
        <div className="mx-auto max-w-3xl space-y-6">{children}</div>
      </main>
    </Sidebar>
  );
}
