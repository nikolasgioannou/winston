import { canonicalJson } from "@winston/contracts/json";
import {
  artifactTransferSchema,
  artifactTransferTokenSchema,
  type ArtifactTransfer,
  inboxTransferSchema,
  inboxTransferTokenSchema,
  type InboxTransfer,
} from "@winston/contracts/artifacts";
import { boundedJson } from "./http-body";

export function createTransferAuthority(origin: URL) {
  async function authorize<Transfer extends ArtifactTransfer | InboxTransfer>(
    token: string,
    transfer: Transfer,
    config: {
      path: string;
      tokenSchema: { parse(input: unknown): string };
      transferSchema: { parse(input: unknown): Transfer };
    },
  ) {
    config.tokenSchema.parse(token);
    const response = await fetch(new URL(config.path, origin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(config.transferSchema.parse(transfer)),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    return (
      canonicalJson(config.transferSchema.parse(await boundedJson(response.body, 4096))) ===
      canonicalJson(transfer)
    );
  }
  return {
    inbox: (token: string, transfer: InboxTransfer) =>
      authorize(token, transfer, {
        path: "/api/transfers/inbox/authorize",
        tokenSchema: inboxTransferTokenSchema,
        transferSchema: inboxTransferSchema,
      }),
    artifact: (token: string, transfer: ArtifactTransfer) =>
      authorize(token, transfer, {
        path: "/api/transfers/artifacts/authorize",
        tokenSchema: artifactTransferTokenSchema,
        transferSchema: artifactTransferSchema,
      }),
  };
}
