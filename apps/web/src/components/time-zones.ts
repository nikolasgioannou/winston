import type { SelectOption } from "@winston/ui";

/** How far a zone is from UTC right now, e.g. `GMT+1`. */
function offsetOf(zone: string, now: Date) {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

let options: SelectOption<string>[] | undefined;

/**
 * Every IANA zone the runtime knows, labelled for searching
 * (`Europe/London · GMT+1`), sorted by name.
 */
export function timeZoneOptions() {
  if (options) return options;
  const now = new Date();
  const zones = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  options = [...zones].sort().map((zone) => ({
    value: zone,
    label: `${zone.replaceAll("_", " ")} · ${offsetOf(zone, now)}`,
  }));
  return options;
}
