import { z } from "zod";
import { element } from "./messages/xml";

const burstSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  messageIds: z.array(z.uuid()).min(1).max(1000),
});

export function serializeMessageBurst(input: z.infer<typeof burstSchema>) {
  const burst = burstSchema.parse(input);
  return element(
    "system_event",
    { kind: "message_burst", revision: burst.revision },
    burst.messageIds.map((id) => element("message", { id })).join("\n"),
  );
}
