import { z } from "zod";

const epoch = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const lease = {
  epoch,
  holder: z.uuid(),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

export const browserOwnershipSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("frozen"), epoch }),
  z.strictObject({ phase: z.literal("agent"), ...lease }),
  z.strictObject({ phase: z.literal("pending"), ...lease }),
  z.strictObject({ phase: z.literal("human"), ...lease }),
]);
export const browserAccessSchema = z.strictObject({ epoch, holder: lease.holder });
export const browserLeaseSchema = z.strictObject({
  holder: lease.holder,
  expiresAt: lease.expiresAt,
});
export type BrowserOwnership = z.infer<typeof browserOwnershipSchema>;
export type BrowserAccess = z.infer<typeof browserAccessSchema>;
export type BrowserLease = z.infer<typeof browserLeaseSchema>;
