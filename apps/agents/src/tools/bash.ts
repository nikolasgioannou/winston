/**
 * The `bash` tool (docs/design.md §5): a shell command on the user's VM, run
 * as `winston` through the gateway. Almost every capability goes through it,
 * via the `winston` CLI.
 */
import { mintRunToken, type RunKind } from "@winston/domain/run-token";
import type { ExecResult } from "@winston/domain/frames";
import type { ToolDefinition } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { tool } from "ai";
import { z } from "zod";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";

/** How long a command may run: short for the front of house, which must stay responsive. */
export const bashTimeoutMs: Record<RunKind, number> = {
  front: 10_000,
  background: 10 * 60_000,
};

/** About 4k tokens of output go back into the model's context (§2). */
export const modelOutputChars = 16_000;

/** A run token outlives its command by this much, for CLI calls near the end. */
const runTokenGraceMs = 5 * 60_000;

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("The shell command, run with bash in your home directory."),
});

function description(kind: RunKind) {
  const seconds = String(bashTimeoutMs[kind] / 1000);
  return `Run a shell command on your computer (Linux, as you, in /home/winston). It must finish within ${seconds} seconds. Long output is cut short, and the full output is saved to a file you can read with sed or rg.`;
}

/** How `bash` appears to the model, for the prompt version. */
export function bashDefinition(kind: RunKind): ToolDefinition {
  return {
    name: "bash",
    description: description(kind),
    inputSchema: z.toJSONSchema(inputSchema),
  };
}

/** The command's result as the model reads it, cut to a head and tail when it's long. */
function render(result: ExecResult, timeoutMs: number) {
  const lines = [
    result.timedOut
      ? `The command was stopped after ${String(timeoutMs / 1000)} seconds, the limit here. Partial output follows.`
      : `exit code ${String(result.exitCode)}`,
  ];
  if (result.stdout) lines.push("--- stdout ---", result.stdout.trimEnd());
  if (result.stderr) lines.push("--- stderr ---", result.stderr.trimEnd());
  if (result.truncated)
    lines.push("(Output past 1 MiB per stream was dropped.)");
  return lines.join("\n");
}

function cut(text: string) {
  const head = Math.floor(modelOutputChars * 0.6);
  const tail = modelOutputChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${String(omitted)} characters omitted …]\n${text.slice(-tail)}`;
}

/** What the model hears when the command couldn't run, or its fate is unknown. */
function unavailable(error: GatewayError) {
  if (error.code === "vm_unreachable")
    return "Your computer stopped responding before the command finished. It may or may not have completed; check before running it again.";
  return "Your computer isn't reachable right now, so the command didn't run. Tell the user if it matters.";
}

export function bashTool(context: {
  vm: VmClient;
  logger: Logger;
  runTokenSecret: string;
  run: { runId: string; userId: string; kind: RunKind };
}) {
  const { vm, run } = context;
  const timeoutMs = bashTimeoutMs[run.kind];
  let step = 0;

  return tool({
    description: description(run.kind),
    inputSchema,
    execute: async ({ command }) => {
      step += 1;
      const token = mintRunToken(
        context.runTokenSecret,
        run,
        timeoutMs + runTokenGraceMs,
      );
      let result: ExecResult;
      try {
        result = await vm.exec(run.userId, {
          cmd: command,
          env: { WINSTON_RUN_TOKEN: token },
          timeoutMs,
        });
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        context.logger.warn(
          { err: error, command },
          "bash couldn't reach the VM",
        );
        return unavailable(error);
      }

      const full = render(result, timeoutMs);
      if (full.length <= modelOutputChars) return full;

      // Too long for the context: keep a head and tail, and save the rest on the VM.
      const path = `.winston/outputs/${run.runId}/${String(step)}.txt`;
      const saved = await vm
        .writeFile(run.userId, path, new TextEncoder().encode(full))
        .then(() => true)
        .catch((error: unknown) => {
          context.logger.warn(
            { err: error, path },
            "saving full bash output failed",
          );
          return false;
        });
      return `${cut(full)}\n${
        saved
          ? `(Full output, ${String(full.length)} characters, saved to ~/${path})`
          : "(The full output couldn't be saved.)"
      }`;
    },
  });
}
