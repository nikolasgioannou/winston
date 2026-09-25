import { gmailLabelListSchema, gmailReadTargetSchema } from "@winston/contracts/gmail";
import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import { createGoogleReadRequest, type GoogleReadOptions } from "./read-request";
import { GmailReadError } from "./gmail";

export function createGmailLabelReader(options: GoogleReadOptions) {
  const request = createGoogleReadRequest(options, {
    service: "gmail",
    error: (kind) => new GmailReadError(kind),
  });
  return async (ownerId: string, input: ResolvedTarget, signal: AbortSignal) => {
    const target = gmailReadTargetSchema.parse(input);
    const result = await request(
      ownerId,
      target,
      "labels",
      new URLSearchParams({ fields: "labels(id,name,type)" }),
      signal,
    );
    const labels = gmailLabelListSchema.parse(result.data).labels;
    return { source: result.source, trust: "untrusted_external_content" as const, labels };
  };
}
