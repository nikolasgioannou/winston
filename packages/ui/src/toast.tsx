import type { CSSProperties } from "react";
import { Toaster as Sonner, toast } from "sonner";

/**
 * Brief feedback after an action ("Saved", "Account disconnected"): Notion's
 * dark pill at the bottom center, stacking and expanding on hover, swipe to
 * dismiss, gone after a few seconds (no close button, like Notion's). Sonner does the stacking and motion;
 * its theme variables point at our tokens. Render `<Toaster />` once at the
 * root, then call `toast("Saved")` or `toast("Title", { description })`.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-center"
      duration={4000}
      // Sonner's default is 14px; ours are compact toasts.
      gap={8}
      style={
        {
          "--normal-bg": "var(--w-inverse-surface)",
          "--normal-text": "var(--w-inverse-fg)",
          "--normal-border": "transparent",
          "--border-radius": "10px",
          "--width": "360px",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "!gap-0 !px-3.5 !py-3 !font-sans !text-sm !shadow-menu",
          title: "!font-medium",
          // Sonner's own theme colors descriptions dark gray; ours sit on a dark pill.
          description: "!text-caption !text-inverse-fg-muted",
        },
      }}
    />
  );
}

export { toast };
