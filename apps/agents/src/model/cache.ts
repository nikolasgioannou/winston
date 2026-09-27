import type { ModelMessage } from "ai";

const ephemeral = { openrouter: { cacheControl: { type: "ephemeral" } } };

/**
 * Marks a message as a prompt-cache breakpoint: everything up to and including
 * it is cached. Anthropic allows four per request. Winston uses two: the
 * system message, passed as `instructions` (it covers the tools too, which
 * Anthropic caches before the system prompt; the provider drops cache
 * control on tools themselves), and a rolling one on the last message of
 * each request.
 *
 * Where the marker goes depends on the role, because the OpenRouter provider
 * only forwards some placements: message-level for system and tool messages,
 * on the last text part for user messages. Assistant messages can't carry one
 * (it's dropped or ignored), so it throws.
 */
export function cacheBreakpoint<Message extends ModelMessage>(
  message: Message,
): Message {
  switch (message.role) {
    case "system":
    case "tool":
      return {
        ...message,
        providerOptions: { ...message.providerOptions, ...ephemeral },
      };
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
            providerOptions: { ...last.providerOptions, ...ephemeral },
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
