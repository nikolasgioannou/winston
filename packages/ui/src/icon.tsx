import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";

export function Icon({
  icon: Component,
  ...props
}: { icon: LucideIcon } & ComponentProps<LucideIcon>) {
  return <Component size={18} strokeWidth={1.7} aria-hidden="true" {...props} />;
}
