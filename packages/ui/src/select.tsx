import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { controlSizeClasses, type ControlSize } from "./control-size";
import { optionClasses, popupClasses, selectorClasses } from "./popup-styles";

export type Option = { value: string; label: string };

export function Select({
  label,
  options,
  value,
  onValueChange,
  disabled = false,
  size = "md",
}: {
  label: string;
  options: Option[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  size?: ControlSize;
}) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <BaseSelect.Label className="mb-2 block text-sm font-medium">{label}</BaseSelect.Label>
      <BaseSelect.Trigger
        className={`${selectorClasses} ${controlSizeClasses[size]}`}
        data-size={size}
      >
        <BaseSelect.Value className="min-w-0 truncate" placeholder="Choose an option" />
        <BaseSelect.Icon>
          <ChevronDown size={16} aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup
            className={`${popupClasses} max-w-[calc(100vw-2rem)] min-w-(--anchor-width) p-1`}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item key={option.value} value={option.value} className={optionClasses}>
                  <BaseSelect.ItemText className="min-w-0 flex-1 whitespace-normal wrap-anywhere">
                    {option.label}
                  </BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator>
                    <Check size={15} aria-hidden="true" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
