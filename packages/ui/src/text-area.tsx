import { useId, type ComponentProps } from "react";

export function TextArea({ label, ...props }: ComponentProps<"textarea"> & { label: string }) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium">
        {label}
      </label>
      <textarea
        {...props}
        id={id}
        className={`w-full resize-y rounded-md border-0 bg-input px-2.5 py-2 text-sm shadow-input transition-[box-shadow,background-color] duration-120 ease-in-out focus:shadow-input-focus focus:outline-none disabled:opacity-45 motion-reduce:transition-none ${props.className ?? ""}`}
      />
    </div>
  );
}
