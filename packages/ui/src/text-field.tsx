import { useId, type ComponentProps } from "react";
import { controlSizeClasses, type ControlSize } from "./control-size";

export function TextField({
  label,
  hint,
  error,
  size = "md",
  ...props
}: Omit<ComponentProps<"input">, "size"> & {
  size?: ControlSize;
  label: string;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  const inputId = props.id ?? id;

  return (
    <div>
      <label htmlFor={inputId} className="mb-2 block text-sm font-medium">
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        data-size={size}
        className={`w-full shrink-0 rounded-md border-0 bg-input px-2.5 text-sm whitespace-nowrap
          shadow-input transition-[box-shadow,background-color] duration-120 ease-in-out
          focus:shadow-input-focus focus:outline-none disabled:opacity-45 motion-reduce:transition-none
          ${controlSizeClasses[size]} ${props.className ?? ""}`}
        aria-invalid={Boolean(error)}
        aria-describedby={hint || error ? `${id}-detail` : undefined}
      />
      {(hint || error) && (
        <p id={`${id}-detail`} className={`mt-2 text-xs ${error ? "text-danger" : "text-muted"}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
