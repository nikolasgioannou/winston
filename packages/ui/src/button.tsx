import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { controlHeight } from "./control";

// Notion's buttons: 6px corners, 14px medium text, a quick background fade.
const button = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-control font-medium whitespace-nowrap transition-[background-color] duration-100 ease-in-out outline-none select-none disabled:cursor-default disabled:opacity-40",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-on-accent hover:bg-accent-hover focus-visible:shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-focus)] active:bg-accent-pressed",
        secondary:
          "bg-button text-fg shadow-button hover:bg-button-hover focus-visible:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)] active:bg-button-pressed",
        ghost:
          "text-fg-secondary hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)] active:bg-pressed",
        danger:
          "bg-button text-error-text shadow-button hover:bg-error-bg focus-visible:shadow-[inset_0_0_0_1px_var(--w-error-focus),0_0_0_1px_var(--w-error-focus)] active:bg-error-bg",
      },
      size: {
        sm: `${controlHeight.sm} px-2`,
        md: `${controlHeight.md} px-3`,
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = Omit<ComponentProps<typeof BaseButton>, "className"> &
  VariantProps<typeof button> & { className?: string };

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <BaseButton
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  );
}
