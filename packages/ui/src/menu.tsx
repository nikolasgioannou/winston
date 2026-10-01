import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement } from "react";
import { cn } from "./cn";
import { controlHeight } from "./control";

export interface MenuAction {
  label: string;
  onSelect: () => void;
  /** Destructive, like Disconnect: shown in red. */
  danger?: boolean;
}

/**
 * A short list of actions under a button, usually an `IconButton` with ⋯:
 * the same popup as `Select`, opening below the trigger's right edge.
 */
export function Menu({
  trigger,
  actions,
}: {
  trigger: ReactElement;
  actions: readonly MenuAction[];
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
          <BaseMenu.Popup className="min-w-44 rounded-[10px] bg-surface-raised p-1 text-fg shadow-menu transition-opacity duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
            {actions.map((action) => (
              <BaseMenu.Item
                key={action.label}
                onClick={action.onSelect}
                className={cn(
                  "flex cursor-pointer items-center rounded-md px-2.5 text-control transition-[background-color] duration-20 ease-in outline-none select-none data-highlighted:bg-hover",
                  controlHeight.md,
                  action.danger ? "text-error-text" : "text-fg",
                )}
              >
                {action.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
