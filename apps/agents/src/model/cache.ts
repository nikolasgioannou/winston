import type { ModelMessage } from "ai";

/** How long a cache entry lives: Anthropic's default five minutes, or an hour (writes cost 2× base input instead of 1.25×). */
export type CacheTtl = "5m" | "1h";

/** A lifetime in milliseconds. Each read starts it over. */
export const cacheTtlMs: Record<CacheTtl, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

const ephemeral = (ttl: CacheTtl) => ({
  openrouter: {
    cacheControl:
      ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
  },
});

/**
 * Marks a message as a prompt-cache breakpoint: everything up to and including
 * it is cached. Anthropic allows four per request. Winston uses two: the
 * system message, passed as `instructions` (it covers the tools too, which
 * Anthropic caches before the system prompt; the provider drops cache
 * control on tools themselves), and a rolling one on the last message of
 * each request.
 *
 * Where the marker goes depends on the role, because the OpenRouter provider
 * only forwards some placements: message-level for system messages, on the
 * last result of a tool message (a tool message's own marker is copied onto
 * every result in it, and parallel tool calls share one message, which would
 * pass Anthropic's limit), on the last text part for user messages. Assistant
 * messages can't carry one (it's dropped or ignored), so it throws.
 *
 * A request's markers must share one lifetime here: Anthropic requires
 * longer-lived markers before shorter ones, and Winston never mixes them.
 */
export function cacheBreakpoint<Message extends ModelMessage>(
  message: Message,
  ttl: CacheTtl = "5m",
): Message {
  switch (message.role) {
    case "system":
      return {
        ...message,
        providerOptions: { ...message.providerOptions, ...ephemeral(ttl) },
      };
    case "tool": {
      const last = message.content.at(-1);
      if (last?.type !== "tool-result") return message;
      return {
        ...message,
        content: [
          ...message.content.slice(0, -1),
          {
            ...last,
            providerOptions: { ...last.providerOptions, ...ephemeral(ttl) },
          },
        ],
      };
    }
    case "user": {
      const parts =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      const last = parts.at(-1);
      if (!last) return message;
      return {
        ...message,
        content: [
          ...parts.slice(0, -1),
          {
            ...last,
            providerOptions: { ...last.providerOptions, ...ephemeral(ttl) },
          },
        ],
      };
    }
    case "assistant":
      throw new Error(
        "Assistant messages can't carry a cache breakpoint through OpenRouter.",
      );
  }
}

/**
 * Marks the request's last message (new input, or a tool result) as the
 * rolling cache breakpoint, so each request caches everything up to itself
 * and the next one reads it back (§16). Only the request copy is marked.
 */
export function withRollingBreakpoint(
  messages: readonly ModelMessage[],
  ttl: CacheTtl = "5m",
) {
  const last = messages.at(-1);
  if (!last || last.role === "assistant") return [...messages];
  return [...messages.slice(0, -1), cacheBreakpoint(last, ttl)];
}
