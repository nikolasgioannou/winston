import { Menu as BaseMenu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";
import { Button } from "./button";
import { optionClasses, popupClasses } from "./popup-styles";

export function Menu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onClick: () => void }[];
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={<Button iconOnly variant="quiet" aria-label={label} />}>
        <MoreHorizontal size={18} aria-hidden="true" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align="end" className="z-50">
          <BaseMenu.Popup className={`${popupClasses} min-w-44 p-1`}>
            {items.map((item) => (
              <BaseMenu.Item key={item.label} onClick={item.onClick} className={optionClasses}>
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
