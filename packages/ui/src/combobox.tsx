import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { controlSizeClasses, type ControlSize } from "./control-size";
import { optionClasses, popupClasses, selectorClasses } from "./popup-styles";

export function Combobox({
  label,
  items,
  value,
  onValueChange,
  placeholder = "Search…",
  emptyMessage = "No matches found.",
  size = "md",
  disabled = false,
}: {
  label: string;
  items: string[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  size?: ControlSize;
  disabled?: boolean;
}) {
  return (
    <BaseCombobox.Root
      items={items}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <BaseCombobox.Label className="mb-2 block text-sm font-medium">{label}</BaseCombobox.Label>
      <BaseCombobox.Trigger
        className={`${selectorClasses} ${controlSizeClasses[size]} text-left`}
        data-size={size}
      >
        <span className="truncate">
          <BaseCombobox.Value placeholder="Choose an option" />
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </BaseCombobox.Trigger>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={6} className="z-50">
          <BaseCombobox.Popup className={`${popupClasses} min-w-(--anchor-width)`}>
            <div className="sticky top-0 z-10 flex h-10 items-center gap-2 border-b border-line bg-paper px-3">
              <Search size={16} aria-hidden="true" className="text-muted" />
              <BaseCombobox.Input
                className={`min-w-0 flex-1 shrink-0 bg-transparent whitespace-nowrap outline-none ${controlSizeClasses[size]}`}
                data-size={size}
                placeholder={placeholder}
                aria-label={`Search ${label.toLowerCase()}`}
              />
            </div>
            <BaseCombobox.Empty>
              <p className="px-3 py-4 text-muted">{emptyMessage}</p>
            </BaseCombobox.Empty>
            <BaseCombobox.List className="p-1">
              {(item: string) => (
                <BaseCombobox.Item key={item} value={item} className={optionClasses}>
                  <span className="flex-1">{item}</span>
                  <BaseCombobox.ItemIndicator>
                    <Check size={15} aria-hidden="true" />
                  </BaseCombobox.ItemIndicator>
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
