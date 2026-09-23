import type { CliRequest } from "@winston/contracts/cli";

export const commands = [
  {
    command: "accounts.list",
    description: "List connected accounts available to this task.",
    id: false,
  },
  {
    command: "devices.list",
    description: "List proxy computers available to this task.",
    id: false,
  },
  { command: "devices.inspect", description: "Inspect one proxy computer.", id: true },
  {
    command: "operations.inspect",
    description: "Read a recorded operation's current outcome.",
    id: true,
  },
  { command: "operations.cancel", description: "Request cancellation of one operation.", id: true },
] as const satisfies readonly {
  command: CliRequest["command"];
  description: string;
  id: boolean;
}[];

export function help(topic?: string) {
  const selected = commands.filter(
    (item) => !topic || item.command === topic || item.command.startsWith(`${topic}.`),
  );
  if (!selected.length) throw new Error("Unknown command. Run winston --help.");
  return {
    name: "winston",
    commands: selected.map((item) => ({
      usage: `winston ${item.command.replace(".", " ")}${item.id ? " --id <uuid>" : ""} [--json]`,
      description: item.description,
    })),
  };
}
