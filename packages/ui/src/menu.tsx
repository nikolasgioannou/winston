import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";
import { controlHeight } from "./control";

export interface MenuLink {
  label: string;
  href: string;
  /** A 16px icon, e.g. from lucide-react. */
  icon?: ReactNode;
}

/**
 * A button that opens a short list of links, like Notion's dropdowns: the
 * same popup as `Select`, opening below the trigger.
 */
export function Menu({
  trigger,
  links,
}: {
  /** The button that opens it, e.g. `<Button>Add account</Button>`. */
  trigger: ReactElement;
  links: readonly MenuLink[];
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          className="z-50 outline-none"
          align="end"
          sideOffset={4}
        >
          <BaseMenu.Popup className="min-w-40 rounded-[10px] bg-surface-raised p-1 text-fg shadow-menu transition-opacity duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
            {links.map((link) => (
              <BaseMenu.LinkItem
                key={link.href}
                href={link.href}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2.5 text-control text-fg transition-[background-color] duration-20 ease-in outline-none select-none data-highlighted:bg-hover [&>svg]:size-4 [&>svg]:text-icon",
                  controlHeight.md,
                )}
              >
                {link.icon}
                {link.label}
              </BaseMenu.LinkItem>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
