import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teaches tailwind-merge our custom text sizes (styles.css), so it doesn't
// take `text-control` for a color and drop it next to `text-fg`.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["control", "caption", "title"] } },
});

/** Joins class names; later Tailwind classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
