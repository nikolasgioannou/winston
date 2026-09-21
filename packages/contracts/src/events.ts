import { z } from "zod";

export const eventPublicationSchema = z.strictObject({
  key: z.string().min(1).max(256),
  type: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/),
  payload: z.record(z.string(), z.json()),
  destinations: z
    .array(z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/))
    .min(1)
    .max(32),
});

export type EventPublication = z.infer<typeof eventPublicationSchema>;
export type EventPayload = EventPublication["payload"];
