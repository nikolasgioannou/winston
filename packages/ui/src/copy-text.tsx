import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./cn";

/** How long the check shows after copying. */
const copiedForMs = 1500;

/**
 * A value the user may want to copy, like an address: the text itself is a
 * quiet ghost button with a copy icon, which turns into a check once copied.
 * Sized to sit in place of a setting row's description.
 */
export function CopyText({
  text,
  copy,
  className,
}: {
  text: string;
  /**
   * Copies to the clipboard: the text, or what it stands for (a site's
   * share link under its address). A rejection leaves the icon as it was.
   */
  copy: () => Promise<void>;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, copiedForMs);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? `Copied ${text}` : `Copy ${text}`}
      onClick={() => {
        copy().then(
          () => {
            setCopied(true);
          },
          () => undefined,
        );
      }}
      className={cn(
        "-mx-1.5 -my-0.5 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption text-fg-muted transition-[background-color,color] duration-100 outline-none hover:bg-hover hover:text-fg focus-visible:shadow-[inset_0_0_0_1px_var(--w-focus),0_0_0_1px_var(--w-focus)]",
        className,
      )}
    >
      <span className="truncate">{text}</span>
      <Icon className="size-3.5 shrink-0 text-icon" aria-hidden />
    </button>
  );
}
