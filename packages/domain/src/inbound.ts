/**
 * Payloads of `inbound_items`, by type. Written by whoever receives the input
 * (`api` for Telegram) and read when rendering envelopes (docs/design.md §4).
 */
import { z } from "zod";

/** Who originally sent a forwarded message. */
export const forwardOriginSchema = z.object({
  kind: z.enum(["user", "hidden_user", "chat", "channel"]),
  /** Display name: a person's full name, or a group or channel title. */
  name: z.string(),
  username: z.string().optional(),
  /** When the original message was sent. */
  sentAt: z.iso.datetime(),
});

/** A Telegram message from the user. Its `sent_at` is the item's `occurred_at`. */
export const userMessagePayloadSchema = z.object({
  text: z.string(),
  telegramMessageId: z.number().int(),
  /** The message this one replies to, if it's a reply. */
  replyToTelegramMessageId: z.number().int().optional(),
  forwardedFrom: forwardOriginSchema.optional(),
});

/**
 * An emoji reaction the user added to one of Winston's messages
 * (`telegram.reaction.added`). The target's text is captured when the
 * reaction arrives, so rendering never needs a lookup.
 */
export const reactionPayloadSchema = z.object({
  emoji: z.string(),
  target: z.object({
    telegramMessageId: z.number().int(),
    /** The start of the message reacted to. */
    text: z.string(),
  }),
});

export type ForwardOrigin = z.infer<typeof forwardOriginSchema>;
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;
export type ReactionPayload = z.infer<typeof reactionPayloadSchema>;
