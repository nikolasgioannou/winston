import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource } from "../commands.ts";
import { json } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Catalog = InferResponseType<
  ApiClient["v1"]["events"]["catalog"]["$get"],
  200
>;
type Entry = Catalog["events"][number];

/** One event: its type and how to subscribe, what it means, its filters and data. */
function showEntry(entry: Entry) {
  const traits = [
    entry.delivery === "always" ? "always delivered" : "subscribable",
    entry.scope ? `--scope one ${entry.scope}` : undefined,
    entry.lead ? "--lead <duration>" : undefined,
  ].filter(Boolean);
  return [
    `${entry.type}  (${traits.join("; ")})`,
    `  ${entry.description}`,
    entry.filters.length > 0
      ? `  Filters: ${entry.filters.map((f) => `--${f.name}${f.value ? ` ${f.value}` : ""}`).join(", ")}`
      : undefined,
    `  Data: ${entry.payload.map((field) => field.name).join(", ") || "(none)"}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export const events: Resource = {
  name: "events",
  description: "The events triggers can subscribe to, and what each carries",
  verbs: [
    {
      name: "catalog",
      summary:
        "Event types, their data, and the filter flags a subscription to each can use",
      usage: "[<domain>]",
      flags: [],
      examples: ["winston events catalog", "winston events catalog mail"],
      run: async ({ client, flags, args }) => {
        const [domain] = args;
        const catalog = await call<Catalog>(
          client.v1.events.catalog.$get({
            query: domain === undefined ? {} : { domain },
          }),
        );
        if (flags.json === true) return json(catalog);
        return catalog.events.map(showEntry).join("\n\n");
      },
    },
  ],
};
