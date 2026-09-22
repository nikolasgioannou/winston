import { z } from "zod";

export const jobReferenceSchema = z.strictObject({
  ownerId: z.uuid(),
  referenceId: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
});

export type JobReference = z.infer<typeof jobReferenceSchema>;
