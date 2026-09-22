import { z } from "zod";

export const turnRoundSchema = z.strictObject({
  text: z.string().max(200_000),
  calls: z
    .array(z.strictObject({ id: z.string().min(1), name: z.string().min(1), input: z.json() }))
    .max(8)
    .refine((calls) => new Set(calls.map((call) => call.id)).size === calls.length),
});
export const turnValueSchema = z.json();
export type TurnRound = z.infer<typeof turnRoundSchema>;
export type TurnValue = z.infer<typeof turnValueSchema>;
