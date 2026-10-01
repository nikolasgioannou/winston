import { filterFields } from "@winston/domain/events";
import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import {
  minutes,
  resolveText,
  standardFlags,
  textFlag,
  type FlagSpec,
  type FlagValues,
} from "../flags.ts";
import { json, list, shortTime } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Triggers = ApiClient["v1"]["triggers"];
type Listed = InferResponseType<Triggers["$get"], 200>;
type Trigger = Listed["triggers"][number];
type Detail = InferResponseType<Triggers[":id"]["$get"], 200>;
type Deleted = InferResponseType<Triggers[":id"]["$delete"], 200>;

/** The subscription filters, generated from the catalog: the same flags as `search`. */
const filterFlags: FlagSpec[] = Object.entries(filterFields).map(
  ([name, field]: [
    string,
    { value?: string; description: string; integer?: true },
  ]) => ({
    name,
    ...(field.value ? { value: field.value } : {}),
    description: `Filter: ${field.description.charAt(0).toLowerCase()}${field.description.slice(1)}`,
    ...(field.integer ? { integer: true } : {}),
  }),
);

const triggerFlags: FlagSpec[] = [
  {
    name: "at",
    value: "<time>",
    description: "Fire once at this time (in the user's zone)",
  },
  {
    name: "cron",
    value: '"<5-field cron>"',
    description:
      'Fire on a schedule, in the user\'s zone: "0 8 * * 1-5" is weekdays at 8',
  },
  {
    name: "on",
    value: "<event-type>",
    description: "Fire on an event (winston events catalog lists them)",
  },
  {
    name: "note",
    value: "<text>",
    description:
      "What to do when it fires, for your future self: text, - or @path",
    text: true,
  },
  ...filterFlags,
  {
    name: "native",
    value: '"<query>"',
    description:
      'Mail only: Gmail search syntax, e.g. "from:dana has:attachment"',
  },
  {
    name: "scope",
    value: "<thr_id|evt_id>",
    description: "Only this thread (mail) or event (calendar)",
  },
  {
    name: "lead",
    value: "<duration>",
    description: "For calendar.event.starting: how long before (15m, 1h)",
  },
  standardFlags.account,
  {
    name: "max-fires",
    value: "<n>",
    description: "Stop after firing this many times (1 for a one-shot)",
    integer: true,
  },
  { name: "expires", value: "<time>", description: "Stop at this time" },
  {
    name: "on-expire",
    value: "<text>",
    description:
      "If it expires before using its fires, start a run with this note (how you notice something didn't happen)",
    text: true,
  },
];

/** The create/update request from the flags; only what was given. */
async function requestOf(flags: FlagValues, context: Context) {
  const filter: Record<string, string | number | boolean> = {};
  for (const name of Object.keys(filterFields)) {
    const value = flags[name];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      value === true
    )
      filter[name] = value;
  }
  const note = textFlag(flags, "note");
  const onExpire = textFlag(flags, "on-expire");
  const lead = textFlag(flags, "lead");
  const optional = {
    at: textFlag(flags, "at"),
    cron: textFlag(flags, "cron"),
    on: textFlag(flags, "on"),
    native: textFlag(flags, "native"),
    scope: textFlag(flags, "scope"),
    account: textFlag(flags, "account"),
    expires: textFlag(flags, "expires"),
  };
  return {
    ...Object.fromEntries(
      Object.entries(optional).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(note === undefined
      ? {}
      : { note: await resolveText(note, context.text) }),
    ...(onExpire === undefined
      ? {}
      : { onExpire: await resolveText(onExpire, context.text) }),
    ...(lead === undefined ? {} : { lead: minutes(lead) }),
    ...(typeof flags["max-fires"] === "number"
      ? { maxFires: flags["max-fires"] }
      : {}),
  };
}

/** A filter as the flags that would make it: `--from dana --unread`. */
const filterWords = (filter: Trigger["filter"]) =>
  Object.entries(filter)
    .map(([name, value]) =>
      value === true ? `--${name}` : `--${name} ${String(value)}`,
    )
    .join(" ");

const fired = (trigger: Trigger) =>
  trigger.maxFires === null
    ? `fired ${String(trigger.fireCount)}`
    : `fired ${String(trigger.fireCount)} of ${String(trigger.maxFires)}`;

const firstLine = (text: string) => {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  const chars = Array.from(line);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : line;
};

/** One line per trigger: what wakes it, how often it has, and its note. */
export function triggerLine(trigger: Trigger, timeZone: string) {
  const when =
    trigger.kind === "schedule"
      ? [
          trigger.nextFireAt
            ? `next ${shortTime(trigger.nextFireAt, timeZone)}`
            : "no next time",
          trigger.cron ? `cron "${trigger.cron}"` : "once",
        ]
      : [
          `on ${trigger.on ?? ""}`,
          filterWords(trigger.filter) || undefined,
          trigger.native ? `--native "${trigger.native}"` : undefined,
          trigger.scope ? `in ${trigger.scope}` : undefined,
          trigger.leadMinutes
            ? `${String(trigger.leadMinutes)}m before`
            : undefined,
        ];
  return [
    trigger.id,
    trigger.status === "active" ? undefined : trigger.status,
    ...when,
    fired(trigger),
    trigger.expiresAt
      ? `expires ${shortTime(trigger.expiresAt, timeZone)}`
      : undefined,
    firstLine(trigger.note),
  ]
    .filter(Boolean)
    .join("  ");
}

function showTrigger(trigger: Trigger, timeZone: string) {
  const indent = (text: string) =>
    text
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  return [
    `${trigger.id} · ${trigger.kind} · ${trigger.status}`,
    trigger.kind === "subscription"
      ? `On: ${trigger.on ?? ""}${trigger.account ? ` (${trigger.account})` : ""}`
      : trigger.cron
        ? `Cron: "${trigger.cron}" (${timeZone})`
        : `At: ${trigger.at ? shortTime(trigger.at, timeZone) : ""}`,
    filterWords(trigger.filter)
      ? `Filter: ${filterWords(trigger.filter)}`
      : undefined,
    trigger.native ? `Native: "${trigger.native}"` : undefined,
    trigger.scope ? `Scope: ${trigger.scope}` : undefined,
    trigger.leadMinutes
      ? `Lead: ${String(trigger.leadMinutes)} min before`
      : undefined,
    `Fired: ${fired(trigger).replace("fired ", "")}`,
    trigger.nextFireAt
      ? `Next: ${shortTime(trigger.nextFireAt, timeZone)}`
      : undefined,
    trigger.expiresAt
      ? `Expires: ${shortTime(trigger.expiresAt, timeZone)}${trigger.onExpire ? `, then: ${trigger.onExpire}` : ""}`
      : undefined,
    "Note:",
    indent(trigger.note),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const needId = (args: string[]) => {
  const [id] = args;
  if (!id)
    throw CliError.usage(
      "Which trigger? Pass a trg_ id.",
      "winston trigger list shows them.",
    );
  return id;
};

const examples = [
  'winston trigger create --at "fri 2:45pm" --note "Remind Nik to leave for the dentist (3:15)."',
  'winston trigger create --cron "0 8 * * 1-5" --note "Morning briefing: today\'s meetings and anything urgent in mail."',
  'winston trigger create --on mail.message.received --from acme.com --category primary --note "A client wrote: does it need a reply today? Tell Nik if so."',
  'winston trigger create --on calendar.event.starting --lead 10m --external --note "Brief Nik on who\'s in the meeting, from notes and recent mail."',
  'winston trigger create --on mail.message.received --scope thr_91a --max-fires 1 --expires "fri 9am" --note "Dana replied about the lease; summarize for the user" --on-expire "Dana never replied; offer to draft a nudge"',
];

export const trigger: Resource = {
  name: "trigger",
  description:
    "What wakes you up: schedules and event subscriptions, each with a note to yourself",
  ids: ["trg"],
  verbs: [
    {
      name: "create",
      summary:
        "Set a schedule (--at, --cron) or an event subscription (--on), with a note for when it fires",
      flags: triggerFlags,
      examples,
      run: async (context) => {
        const { client, flags } = context;
        const request = await requestOf(flags, context);
        if (!("note" in request))
          throw CliError.usage("--note is required: what to do when it fires.");
        const created = await call<Detail>(
          client.v1.triggers.$post({
            json: { ...request, note: request.note },
          }),
        );
        return flags.json === true
          ? json(created)
          : `Created ${showTrigger(created.trigger, created.timeZone)}`;
      },
    },
    {
      name: "list",
      summary: "Your triggers, newest first (active ones unless --all)",
      flags: [
        {
          name: "kind",
          value: "schedule|subscription",
          description: "Only one kind",
        },
        { name: "all", description: "Include exhausted and expired ones" },
      ],
      examples: [
        "winston trigger list",
        "winston trigger list --kind subscription --all",
      ],
      run: async ({ client, flags }) => {
        const kind = textFlag(flags, "kind");
        const result = await call<Listed>(
          client.v1.triggers.$get({
            query: {
              ...(kind ? { kind } : {}),
              ...(flags.all === true ? { all: "true" } : {}),
            },
          }),
        );
        if (flags.json === true) return json(result);
        if (result.triggers.length === 0)
          return flags.all === true ? "No triggers." : "No active triggers.";
        return list(
          result.triggers.map((t) => triggerLine(t, result.timeZone)),
          { limit: result.triggers.length },
        );
      },
    },
    {
      name: "get",
      summary:
        "One trigger in full: what wakes it, filters, fires, expiry and note",
      usage: "<trg_id>",
      flags: [],
      examples: ["winston trigger get trg_01k5…"],
      run: async ({ client, flags, args }) => {
        const result = await call<Detail>(
          client.v1.triggers[":id"].$get({ param: { id: needId(args) } }),
        );
        return flags.json === true
          ? json(result)
          : showTrigger(result.trigger, result.timeZone);
      },
    },
    {
      name: "update",
      summary:
        "Change a trigger: any create flag (filters given replace its filters)",
      usage: "<trg_id>",
      flags: triggerFlags,
      examples: [
        'winston trigger update trg_01k5… --cron "0 7 * * 1-5"',
        'winston trigger update trg_01k5… --expires "next fri 9am"',
      ],
      run: async (context) => {
        const { client, flags, args } = context;
        const id = needId(args);
        const request = await requestOf(flags, context);
        if (Object.keys(request).length === 0)
          throw CliError.usage(
            "Nothing to change.",
            "Pass any create flag, like --note or --expires.",
          );
        const updated = await call<Detail>(
          client.v1.triggers[":id"].$patch({ param: { id }, json: request }),
        );
        return flags.json === true
          ? json(updated)
          : `Updated ${showTrigger(updated.trigger, updated.timeZone)}`;
      },
    },
    {
      name: "delete",
      summary: "Delete a trigger; it never fires again",
      usage: "<trg_id>",
      flags: [],
      examples: ["winston trigger delete trg_01k5…"],
      run: async ({ client, flags, args }) => {
        const result = await call<Deleted>(
          client.v1.triggers[":id"].$delete({ param: { id: needId(args) } }),
        );
        return flags.json === true ? json(result) : `Deleted ${result.id}.`;
      },
    },
  ],
};
