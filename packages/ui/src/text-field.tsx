import { Field } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { controlHeight, type ControlSize } from "./control";

// Notion's inputs: a faint fill, 6px corners, and a crisp 1px blue ring on focus.
const input =
  "w-full rounded-md bg-field text-sm text-fg shadow-[inset_0_0_0_1px_var(--w-border)] transition-shadow outline-none placeholder:text-fg-subtle focus:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)] data-invalid:shadow-[inset_0_0_0_1px_var(--w-error-focus),0_0_0_1px_var(--w-error-focus)] data-disabled:opacity-40";

export interface TextFieldProps extends Omit<
  ComponentProps<typeof Field.Control>,
  "className" | "size"
> {
  label?: ReactNode;
  description?: ReactNode;
  /** Shown when the field is invalid. */
  error?: ReactNode;
  /** Fixed text after the input, like a domain after a name. */
  suffix?: ReactNode;
  size?: ControlSize;
  className?: string;
}

export function TextField({
  label,
  description,
  error,
  suffix,
  size = "md",
  className,
  ...props
}: TextFieldProps) {
  return (
    <Field.Root
      className={cn("flex flex-col gap-1", className)}
      invalid={error !== undefined}
    >
      {label !== undefined && (
        <Field.Label className="text-sm font-medium text-fg">
          {label}
        </Field.Label>
      )}
      {suffix === undefined ? (
        <Field.Control
          className={cn(
            input,
            controlHeight[size],
            size === "sm" ? "px-1.5" : "px-2",
          )}
          {...props}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Field.Control
            className={cn(
              input,
              controlHeight[size],
              "min-w-0 flex-1",
              size === "sm" ? "px-1.5" : "px-2",
            )}
            {...props}
          />
          <span className="shrink-0 text-sm text-fg-muted">{suffix}</span>
        </div>
      )}
      {description !== undefined && (
        <Field.Description className="text-caption text-fg-muted">
          {description}
        </Field.Description>
      )}
      {error !== undefined && (
        <Field.Error match className="text-caption text-error-text">
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}
