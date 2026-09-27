import type { ModelMessage } from "ai";

/**
 * Marks a message as a prompt-cache breakpoint: everything up to and including
 * it is cached. Put one on the system message, passed as `instructions`
 * (it also covers the tools,
 * as Anthropic caches tools before the system prompt; the provider drops
 * cache control on tools themselves) and a rolling one on the last message
 * of the previous turn. Anthropic allows four per request.
 */
export function cacheBreakpoint<Message extends ModelMessage>(
  message: Message,
): Message {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      openrouter: {
        ...message.providerOptions?.openrouter,
        cacheControl: { type: "ephemeral" },
      },
    },
  };
}
