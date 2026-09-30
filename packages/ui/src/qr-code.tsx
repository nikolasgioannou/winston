import { generate } from "lean-qr";
import { toSvgPath } from "lean-qr/extras/svg";
import { cn } from "./cn";

/** The blank margin scanners need around a code, in modules (ISO 18004). */
const quietZone = 4;

/**
 * A QR code, drawn as one SVG path. It stays black on white in dark mode too,
 * since many phone cameras can't read an inverted code.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  /** What scanning it does, for screen readers. */
  label: string;
  className?: string;
}) {
  const code = generate(value);
  const size = code.size + quietZone * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${String(-quietZone)} ${String(-quietZone)} ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className={cn("rounded-lg bg-white text-black", className)}
    >
      <path d={toSvgPath(code)} fill="currentColor" />
    </svg>
  );
}
