import { Combobox } from "@base-ui/react/combobox";
import { Check } from "lucide-react";
import { cn } from "./cn";
import { controlHeight } from "./control";
import type { SelectOption } from "./select";

/**
 * A select you type into to filter, for long lists like time zones: the
 * input looks like a `TextField`, and the list like `Select`'s popup.
 */
export function SearchSelect<Value extends string>({
  options,
  value,
  onValueChange,
  placeholder,
  emptyText = "No matches",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  options: readonly SelectOption<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  "aria-label": string;
}) {
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <Combobox.Root
      items={options}
      value={selected}
      onValueChange={(next) => {
        if (next) onValueChange(next.value);
      }}
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      autoHighlight
      openOnInputClick
      // Hundreds of options render fine, but a short list reads better.
      limit={50}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <Combobox.Input
        aria-label={ariaLabel}
        {...(placeholder !== undefined ? { placeholder } : {})}
        className={cn(
          "w-full rounded-md bg-field px-2 text-sm text-fg shadow-[inset_0_0_0_1px_var(--w-border)] transition-shadow outline-none placeholder:text-fg-subtle focus:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)] data-disabled:opacity-40",
          controlHeight.md,
          className,
        )}
      />
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4}>
          <Combobox.Popup className="w-(--anchor-width) rounded-[10px] bg-surface-raised p-1 text-fg shadow-menu transition-opacity duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Combobox.Empty className="px-2.5 py-1.5 text-sm text-fg-muted empty:hidden">
              {emptyText}
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(var(--available-height),18rem)] overflow-y-auto">
              {(option: SelectOption<Value>) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className={cn(
                    "flex cursor-pointer items-center gap-1 rounded-md px-2.5 text-control outline-none select-none data-highlighted:bg-hover",
                    controlHeight.md,
                  )}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                  <Combobox.ItemIndicator className="text-fg">
                    <Check size={14} strokeWidth={2} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
