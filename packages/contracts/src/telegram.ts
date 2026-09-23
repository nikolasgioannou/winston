import { z } from "zod";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const telegramKeyboardSchema = z.strictObject({
  inline_keyboard: z
    .array(
      z
        .array(
          z.strictObject({
            text: z.string().min(1).max(64),
            callback_data: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),
          }),
        )
        .min(1)
        .max(4),
    )
    .min(1)
    .max(8),
});
export type TelegramKeyboard = z.infer<typeof telegramKeyboardSchema>;
export const telegramEventKeySchema = z.object({ botId: integer, updateId: integer });
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
  media_group_id: z.string().optional(),
  document: z
    .looseObject({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
    })
    .optional(),
  voice: z.looseObject({ file_id: z.string(), mime_type: z.string().optional() }).optional(),
  audio: z
    .looseObject({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
    })
    .optional(),
  video: z
    .looseObject({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
    })
    .optional(),
  photo: z
    .array(z.looseObject({ file_id: z.string(), width: integer, height: integer }))
    .optional(),
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
