import { z } from "zod";

export const storedObjectSchema = z.strictObject({
  ownerId: z.uuid(),
  id: z.uuid(),
  purpose: z.enum(["artifact", "backup"]),
  size: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type StoredObject = z.infer<typeof storedObjectSchema>;
