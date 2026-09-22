import { z } from "zod";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const telegramBotSchema = z.object({
  id: integer,
  is_bot: z.literal(true),
  username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
});

const messageSchema = z.looseObject({
  message_id: integer,
  date: integer,
  edit_date: integer.optional(),
  from: z.object({ id: integer, is_bot: z.boolean(), first_name: z.string() }).optional(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  text: z.string().optional(),
  caption: z.string().optional(),
});

export const telegramUpdateSchema = z.looseObject({
  update_id: integer,
  message: messageSchema.optional(),
  edited_message: messageSchema.optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export const telegramStatusSchema = z.object({
  binding: z.object({ userId: z.string() }).nullable(),
  challenge: z
    .object({ id: z.uuid(), userId: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
});
export const telegramChallengeSchema = z.object({
  id: z.uuid(),
  url: z.url().refine((value) => new URL(value).origin === "https://t.me"),
});
