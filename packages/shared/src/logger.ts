import pino, { type DestinationStream, type Level, type Logger } from "pino";
import pretty from "pino-pretty";
import { z } from "zod";

export type { Level, Logger };

export interface LoggerOptions {
  level?: Level;
  /** Human-readable output. Defaults to on in a terminal, JSON lines otherwise. */
  pretty?: boolean | undefined;
  /** Where log lines go. Defaults to stdout. */
  destination?: DestinationStream;
}

/** Logging settings every service reads; spread its `shape` into a service's config schema. */
export const logConfigSchema = z.object({
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  /** Forces human-readable (`true`) or JSON (`false`) output; unset means pretty only in a terminal. */
  LOG_PRETTY: z.stringbool().optional(),
});

// Values under these keys (top level or one level down) are replaced before logging.
const sensitiveKeys = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "ciphertext",
];
const redactPaths = sensitiveKeys.flatMap((key) => [key, `*.${key}`]);

/**
 * A structured logger for one service. Add context with `logger.child({ runId })`
 * so every line of a run carries the id. Uses pino without its worker-thread
 * transports, which misbehave under Bun.
 */
export function createLogger(
  service: string,
  options: LoggerOptions = {},
): Logger {
  const usePretty = options.pretty ?? process.stdout.isTTY;
  const destination =
    options.destination ??
    (usePretty
      ? pretty({ colorize: true, ignore: "pid,hostname", sync: true })
      : pino.destination(1));
  return pino(
    {
      level: options.level ?? "info",
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: redactPaths, censor: "[redacted]" },
    },
    destination,
  );
}
