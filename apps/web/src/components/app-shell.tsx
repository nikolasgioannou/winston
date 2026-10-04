import { Link } from "@tanstack/react-router";
import { Sidebar, SidebarDrawer, SidebarItem } from "@winston/ui";
import {
  Blocks,
  CircleUser,
  Globe,
  House,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

/** The signed-in pages: a flat list, no catch-all settings (docs/design.md §20). */
const navigation: NavItem[] = [
  { to: "/home", label: "Home", icon: House },
  // Blocks (apps plugged in), not an envelope: it covers every kind of account.
  { to: "/accounts", label: "Connected accounts", icon: Blocks },
  // The ways the user reaches Winston.
  { to: "/channels", label: "Channels", icon: MessagesSquare },
  // The sites Winston deployed (docs/design.md §9a).
  { to: "/sites", label: "Sites", icon: Globe },
  // Also holds sign-out and account deletion.
  { to: "/profile", label: "Profile", icon: CircleUser },
];

interface NavItem {
  to: "/home" | "/accounts" | "/channels" | "/sites" | "/profile";
  label: string;
  icon: LucideIcon;
}

/** The item for `path`: the longest one it's at or under (so /accounts/acct_1 is Connected accounts). */
function activeItem(path: string) {
  return navigation
    .filter((item) => path === item.to || path.startsWith(`${item.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
}

export interface AppShellProps {
  /** The current path, for highlighting its item. */
  activePath: string;
  children: ReactNode;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  /** The phone drawer, controlled so navigating can close it. */
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
}

/**
 * Every signed-in page's frame: the sidebar on wider screens, and on phones
 * a top bar whose menu button opens the same navigation as a drawer.
 */
export function AppShell({
  activePath,
  children,
  sidebarWidth,
  onSidebarWidthChange,
  drawerOpen,
  onDrawerOpenChange,
}: AppShellProps) {
  const active = activeItem(activePath);
  const nav = (onNavigate?: () => void) =>
    navigation.map((item) => (
      <SidebarItem
        key={item.to}
        icon={<item.icon />}
        selected={item.to === active}
        render={<Link to={item.to} onClick={onNavigate} />}
      >
        {item.label}
      </SidebarItem>
    ));

  return (
    <div className="flex h-dvh bg-surface text-fg">
      <Sidebar
        className="hidden sm:flex"
        {...(sidebarWidth !== undefined ? { defaultWidth: sidebarWidth } : {})}
        {...(onSidebarWidthChange
          ? { onWidthChange: onSidebarWidthChange }
          : {})}
      >
        {nav()}
      </Sidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border-subtle px-2 sm:hidden">
          <SidebarDrawer open={drawerOpen} onOpenChange={onDrawerOpenChange}>
            {nav(() => {
              onDrawerOpenChange(false);
            })}
          </SidebarDrawer>
          <span className="text-sm font-medium">Winston</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
