import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import { controlSizeClasses, iconSizeClasses, type ControlSize } from "./control-size";

const variantClasses = {
  default: "border-line bg-paper enabled:hover:bg-hover",
  primary: "border-ink bg-ink text-white enabled:hover:bg-primary-hover",
  quiet: "border-transparent bg-transparent enabled:hover:bg-hover",
};

export function Button({
  variant = "default",
  className = "",
  size = "md",
  iconOnly = false,
  ...props
}: Omit<ComponentProps<typeof BaseButton>, "className"> & {
  className?: string;
  size?: ControlSize;
  iconOnly?: boolean;
  variant?: "default" | "primary" | "quiet";
}) {
  return (
    <BaseButton
      {...props}
      data-size={size}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md border
        text-sm font-medium whitespace-nowrap transition-[background-color,border-color,box-shadow]
        duration-100 ease-in-out disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none
        ${iconOnly ? `${iconSizeClasses[size]} p-0` : `${controlSizeClasses[size]} px-3`}
        ${variantClasses[variant]} ${className}`}
    />
  );
}
