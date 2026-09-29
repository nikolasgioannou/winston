/**
 * One size scale for every control (buttons, selects, text fields), so
 * controls line up in any row. `md` is the default everywhere.
 */
export type ControlSize = "sm" | "md";

export const controlHeight: Record<ControlSize, string> = {
  sm: "h-7",
  md: "h-8",
};
