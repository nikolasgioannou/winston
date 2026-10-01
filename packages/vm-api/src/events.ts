/**
 * `winston events` (docs/design.md §11, §3): the event catalog, generated
 * from `@winston/domain/events`, so what Winston reads can't drift from what
 * subscriptions accept.
 */
import {
  eventCatalog,
  filterFields,
  payloadFields,
} from "@winston/domain/events";
import { Hono } from "hono";
import { ApiFailure } from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

const domains = [...new Set(eventCatalog.map((event) => event.domain))];

export function eventRoutes() {
  return new Hono<VmApiEnv>().get("/catalog", (c) => {
    const domain = c.req.query("domain");
    if (domain !== undefined && !domains.some((d) => d === domain))
      throw new ApiFailure(
        "invalid_request",
        `There's no ${domain} domain.`,
        `The domains are ${domains.join(", ")}.`,
      );
    return c.json({
      events: eventCatalog
        .filter((event) => domain === undefined || event.domain === domain)
        .map((event) => ({
          type: event.type,
          domain: event.domain,
          description: event.description,
          delivery: event.delivery,
          scope: "scope" in event ? event.scope : null,
          lead: "lead" in event,
          abstraction: "abstraction" in event,
          payload: payloadFields(event),
          filters: event.filters.map((name) => {
            const field: { value?: string; description: string } =
              filterFields[name];
            return {
              name,
              value: field.value ?? null,
              description: field.description,
            };
          }),
        })),
    });
  });
}
