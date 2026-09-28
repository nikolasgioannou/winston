import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { json, record } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Me = InferResponseType<ApiClient["v1"]["me"]["$get"], 200>;

const show = (me: Me, asJson: boolean) =>
  asJson
    ? json(me)
    : record(me.id, `${me.firstName} ${me.lastName}`, me.email, me.timezone);

export const me: Resource = {
  name: "me",
  description: "The user you work for: name, email, time zone",
  verbs: [
    {
      name: "get",
      summary: "Show the user's profile",
      flags: [],
      examples: ["winston me get", "winston me get --json"],
      run: async ({ client, flags }) =>
        show(await call<Me>(client.v1.me.$get()), flags.json === true),
    },
    {
      name: "update",
      summary: "Change the user's profile",
      flags: [
        {
          name: "timezone",
          value: "<iana>",
          description: "Time zone, e.g. America/New_York or Europe/London",
        },
      ],
      examples: ["winston me update --timezone Europe/London"],
      run: async ({ client, flags }) => {
        const timezone = flags.timezone;
        if (typeof timezone !== "string")
          throw CliError.usage(
            "Nothing to update.",
            "Pass --timezone <iana>, e.g. --timezone Europe/London.",
          );
        return show(
          await call<Me>(client.v1.me.$patch({ json: { timezone } })),
          flags.json === true,
        );
      },
    },
  ],
};
