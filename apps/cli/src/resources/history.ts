import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { standardFlags, textFlag } from "../flags.ts";
import { json, list } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type History = ApiClient["v1"]["history"];
type Page = InferResponseType<History["search"]["$get"], 200>;
type One = InferResponseType<History[":id"]["$get"], 200>;
type Item = Page["items"][number];

/** An item as the context window shows it, under its id. */
const itemText = (item: Item) => `${item.id}\n${item.envelope}`;

const kinds = ["message", "event", "task", "action"] as const;

export const history: Resource = {
  name: "history",
  description:
    "Search everything said and done: the user's messages, your replies, events, task reports and your actions",
  ids: ["hist"],
  verbs: [
    {
      name: "search",
      summary:
        "Find past items by words (names, emails and numbers match exactly), best match first",
      usage: "[<text>]",
      flags: [
        {
          name: "type",
          value: "message|event|task|action",
          description:
            "Only messages (the user's and yours), events, task reports or your actions",
        },
        standardFlags.since,
        standardFlags.until,
        {
          ...standardFlags.limit,
          description: "How many to show (default 10)",
        },
        standardFlags.cursor,
      ],
      examples: [
        'winston history search "zuni café"',
        "winston history search lease --type action --since 30d",
        "winston history search --type message --since 2026-07-01 --until 2026-08-01",
      ],
      run: async ({ client, flags, args }) => {
        const type = textFlag(flags, "type");
        if (type !== undefined && !(kinds as readonly string[]).includes(type))
          throw CliError.usage(
            `--type is one of ${kinds.join(", ")}.`,
            "winston history search lease --type action",
          );
        const text = args.join(" ").trim();
        const entries = {
          text: text || undefined,
          type,
          since: textFlag(flags, "since"),
          until: textFlag(flags, "until"),
          limit:
            typeof flags.limit === "number" ? String(flags.limit) : undefined,
          cursor: textFlag(flags, "cursor"),
        };
        const page = await call<Page>(
          client.v1.history.search.$get({
            query: Object.fromEntries(
              Object.entries(entries).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          }),
        );
        if (flags.json === true) return json(page);
        if (page.items.length === 0)
          return text
            ? "Nothing matched. Try other words (a name, a place, a number), or fewer."
            : "Nothing in that range.";
        return list(page.items.map(itemText).join("\n\n").split("\n"), {
          limit: Number.MAX_SAFE_INTEGER,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          narrow: "--type, --since or more words",
        });
      },
    },
    {
      name: "get",
      summary:
        "One item as its envelope; --context adds the items just before and after it",
      usage: "<hist_id>",
      flags: [
        {
          name: "context",
          value: "<n>",
          description: "Also show n items before and after (at most 20)",
          integer: true,
        },
      ],
      examples: [
        "winston history get hist_01k5…",
        "winston history get hist_01k5… --context 3",
      ],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id?.startsWith("hist_"))
          throw CliError.usage(
            "Which item? Pass its hist_ id from winston history search.",
            "winston history get hist_01k5… --context 3",
          );
        const result = await call<One>(
          client.v1.history[":id"].$get({
            param: { id },
            query:
              typeof flags.context === "number"
                ? { context: String(flags.context) }
                : {},
          }),
        );
        if (flags.json === true) return json(result);
        return result.items
          .map((item) =>
            item.id === result.id && result.items.length > 1
              ? itemText({ ...item, id: `${item.id}  ← this one` })
              : itemText(item),
          )
          .join("\n\n");
      },
    },
  ],
};
