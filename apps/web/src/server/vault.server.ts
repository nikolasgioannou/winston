import { localTokenVault, type TokenVault } from "@winston/shared/token-vault";
import { webConfig } from "./config.server";

let vault: TokenVault | undefined;

/**
 * The token vault, for sealing a new connection's refresh token. The site
 * only ever encrypts: in production (M4) its KMS permission is
 * `GenerateDataKey` without `Decrypt`, so only `api` and `agents` can read
 * tokens (docs/design.md §13).
 */
export function tokenVault() {
  return (vault ??= localTokenVault(webConfig().TOKEN_ENCRYPTION_KEY));
}
