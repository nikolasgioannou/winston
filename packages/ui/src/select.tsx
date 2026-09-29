import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./cn";
import { controlHeight, type ControlSize } from "./control";

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
}

export interface SelectProps<Value extends string> {
  options: readonly SelectOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  disabled?: boolean;
  size?: ControlSize;
  className?: string;
  "aria-label"?: string;
}

/** The trigger and its options share padding, so an option sits exactly where the trigger's text was. */
const padding: Record<ControlSize, string> = { sm: "px-2", md: "px-2.5" };

// A hairline-bordered button like the other controls; its menu has Notion's
// 10px corners, soft shadow and hover wash.
export function Select<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  disabled,
  size = "md",
  className,
  ...props
}: SelectProps<Value>) {
  return (
    <BaseSelect.Root
      items={options}
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onValueChange
        ? {
            onValueChange: (next: Value | null) => {
              if (next !== null) onValueChange(next);
            },
          }
        : {})}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <BaseSelect.Trigger
        aria-label={props["aria-label"]}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 rounded-md border border-border text-control whitespace-nowrap text-fg transition-[background-color] duration-20 ease-in outline-none select-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)] data-disabled:cursor-default data-disabled:opacity-40 data-popup-open:bg-hover",
          controlHeight[size],
          padding[size],
          className,
        )}
      >
        <BaseSelect.Value />
        <BaseSelect.Icon className="text-icon">
          <ChevronDown size={14} strokeWidth={2} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        {/* Opens over the trigger (Base UI's default, like Linear): the selected
            option lands exactly where the trigger's text was, and its
            checkmark where the chevron was. It fades in but closes at once,
            since the trigger's text changes as a choice is made. */}
        <BaseSelect.Positioner
          className="z-50 outline-none select-none"
          // Used only when Base UI falls back to opening below (the trigger is
          // near the window's edge, or touch opened it): a gap like other popovers.
          sideOffset={4}
        >
          <BaseSelect.Popup className="min-w-[calc(var(--anchor-width)+6px)] rounded-[10px] bg-surface-raised p-1 text-fg shadow-menu transition-opacity duration-150 outline-none data-ending-style:transition-none data-starting-style:opacity-0">
            <BaseSelect.List className="max-h-(--available-height) overflow-y-auto">
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-1 rounded-md text-control transition-[background-color] duration-20 ease-in outline-none data-highlighted:bg-hover",
                    controlHeight[size],
                    padding[size],
                  )}
                >
                  <BaseSelect.ItemText className="flex-1">
                    {option.label}
                  </BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="text-fg">
                    <Check size={14} strokeWidth={2} />
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
