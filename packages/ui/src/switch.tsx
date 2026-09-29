import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import { cn } from "./cn";

// Notion's toggle: a 30×18 pill that turns blue, with a 14px thumb sliding 12px.
export function Switch({
  className,
  ...props
}: Omit<ComponentProps<typeof BaseSwitch.Root>, "className"> & {
  className?: string;
}) {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative inline-flex h-4.5 w-7.5 shrink-0 cursor-pointer items-center rounded-full bg-switch-off p-0.5 transition-[background-color,box-shadow] duration-200 outline-none focus-visible:shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-focus)] data-checked:bg-accent data-disabled:cursor-default data-disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="size-3.5 rounded-full bg-white transition-transform duration-200 ease-out data-checked:translate-x-3" />
    </BaseSwitch.Root>
  );
}
