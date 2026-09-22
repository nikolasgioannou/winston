import { z } from "zod";

export const googleServiceSchema = z.enum(["gmail", "calendar"]);
export const googleOAuthErrorSchema = z.object({
  response: z.object({ data: z.object({ error: z.string() }) }),
});
export const connectionStartSchema = z.strictObject({
  service: googleServiceSchema,
  connectionId: z.uuid().optional(),
  task: z
    .strictObject({ id: z.uuid(), revision: z.number().int().nonnegative(), blockerId: z.uuid() })
    .optional(),
});
export const connectionSchema = z.strictObject({
  id: z.uuid(),
  service: googleServiceSchema,
  subject: z.string().min(1).max(255),
  email: z.email(),
  scopes: z.array(z.string().max(300)).max(100),
  status: z.enum(["connected", "limited", "reconnect", "disconnected"]),
  revision: z.number().int().nonnegative(),
  calendars: z.array(z.string().min(1).max(1024)).max(100),
});
export const connectionListSchema = z.array(connectionSchema);
export const connectionUrlSchema = z.strictObject({ url: z.url() });
export const calendarSchema = z.object({
  id: z.string().min(1).max(1024),
  summary: z.string().max(1000).optional(),
  accessRole: z.enum(["freeBusyReader", "reader", "writerWithoutPrivateAccess", "writer", "owner"]),
  deleted: z.boolean().optional(),
  summaryOverride: z.string().max(1000).optional(),
  primary: z.boolean().optional(),
});
export const calendarListSchema = z.array(calendarSchema).max(1000);
export const calendarSelectionSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  ids: z.array(z.string().min(1).max(1024)).max(100),
});
export const disconnectConnectionSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
});
export const googleCalendarPageSchema = z.object({
  items: calendarListSchema.optional(),
  nextPageToken: z.string().optional(),
});
export type GoogleCalendar = z.infer<typeof calendarSchema>;
export const googleIdentitySchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email(),
  email_verified: z.literal(true),
  nonce: z.string().min(1),
  azp: z.string().optional(),
});
export const googleGrantSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  email: z.email(),
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).optional(),
  expiresAt: z.iso.datetime(),
  scopes: z.array(z.string().min(1).max(300)).max(100),
});
export const googleScopes = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  calendar: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
} as const;
export type GoogleService = z.infer<typeof googleServiceSchema>;
export type ConnectionStart = z.infer<typeof connectionStartSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type GoogleGrant = z.infer<typeof googleGrantSchema>;
