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

/**
 * A file the user sent with a message (docs/design.md §4, Media). The webhook
 * records what Telegram said about it; `save_attachment` downloads it to the
 * VM and fills in the rest.
 */
export const attachmentSchema = z.object({
  kind: z.enum([
    "photo",
    "document",
    "video",
    "audio",
    "animation",
    "voice",
    "video_note",
  ]),
  telegramFileId: z.string(),
  /** The name from the sender's app. Photos have none. */
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  /**
   * `pending` until saved. `too_large` is over the Bot API's 20 MB download
   * limit, and `failed` couldn't be saved.
   */
  status: z.enum(["pending", "saved", "too_large", "failed"]),
  /** Where it was saved on the VM, e.g. `~/inbox/2026-09-27/photo-140312.jpg`. */
  path: z.string().optional(),
  /** A voice or video note whose speech couldn't be transcribed. */
  transcriptionFailed: z.boolean().optional(),
  /** The copy the model is shown with the message, in the blob store. */
  shown: z
    .object({
      blobKey: z.string(),
      /** An image or PDF goes as a file, text as escaped text. */
      as: z.enum(["image", "pdf", "text"]),
      mediaType: z.string(),
    })
    .optional(),
});

/** A Telegram message from the user. Its `sent_at` is the item's `occurred_at`. */
export const userMessagePayloadSchema = z.object({
  /** The message's text, or a file's caption (empty when there's none). */
  text: z.string(),
  telegramMessageId: z.number().int(),
  /** The message this one replies to, if it's a reply. */
  replyToTelegramMessageId: z.number().int().optional(),
  forwardedFrom: forwardOriginSchema.optional(),
  attachment: attachmentSchema.optional(),
  /** Set when `text` is the transcript of a voice or video note. */
  source: z.literal("voice").optional(),
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
export type Attachment = z.infer<typeof attachmentSchema>;
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;
export type ReactionPayload = z.infer<typeof reactionPayloadSchema>;

/**
 * Winston's cue to say a brief hello (§3, always delivered): the user just
 * linked Telegram from the site. Its payload is empty.
 */
export const onboardingCompletedType = "system.onboarding.completed";

/**
 * A background run's outcome, for the front of house (`task.completed`,
 * `task.failed`; docs/design.md §4, "Processing without responding"). Only
 * the front of house messages the user, so this is how a task reports back.
 */
export const taskResultPayloadSchema = z.object({
  taskId: z.string(),
  /** The start of the brief, so the front of house knows which task this is. */
  brief: z.string(),
  /** The agent's report; for a failure, what went wrong. */
  report: z.string(),
  /** Stopped at the step cap: the report says where it got to. */
  capped: z.boolean().optional(),
  /** Stopped because it was cancelled (`winston task cancel`). */
  cancelled: z.boolean().optional(),
  /** Started by one of Winston's own triggers rather than asked for. */
  trigger: z.enum(["schedule", "event", "expire"]).optional(),
});
export type TaskResultPayload = z.infer<typeof taskResultPayloadSchema>;

/** The inbound item types a background run's outcome becomes. */
export const taskResultTypes = ["task.completed", "task.failed"] as const;
export type TaskResultType = (typeof taskResultTypes)[number];

/**
 * A background run that handed over to the user and is parked until they're
 * done (`task.needs_user`; docs/design.md §1, Browser handoff).
 */
export const taskNeedsUserPayloadSchema = z.object({
  taskId: z.string(),
  brief: z.string(),
  /** What the user needs to do, in the agent's words. */
  reason: z.string(),
});
export type TaskNeedsUserPayload = z.infer<typeof taskNeedsUserPayloadSchema>;
