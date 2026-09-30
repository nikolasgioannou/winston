import type { ConnectionStatus } from "@winston/domain/connections";
import { connections } from "./schema/index.ts";

type ConnectionRow = typeof connections.$inferSelect;

/**
 * A connected account as it may leave the backend (docs/design.md §7,
 * explicit DTOs): everything but the token and sync internals.
 */
export interface ConnectionDto {
  id: string;
  domain: ConnectionRow["domain"];
  provider: ConnectionRow["provider"];
  externalEmail: string;
  alias: string | null;
  scopes: string[];
  capabilities: ConnectionRow["capabilities"];
  grantedAt: string;
  status: ConnectionStatus;
  createdAt: string;
}

/**
 * The columns a `ConnectionDto` needs, for `db.select(connectionDtoColumns)`,
 * so the ciphertext isn't even read.
 */
export const connectionDtoColumns = {
  id: connections.id,
  domain: connections.domain,
  provider: connections.provider,
  externalEmail: connections.externalEmail,
  alias: connections.alias,
  scopes: connections.scopes,
  capabilities: connections.capabilities,
  grantedAt: connections.grantedAt,
  status: connections.status,
  createdAt: connections.createdAt,
};

/**
 * Builds the DTO field by field, so a whole row passed in by mistake still
 * can't carry its token out.
 */
export function toConnectionDto(
  row: Pick<ConnectionRow, keyof typeof connectionDtoColumns>,
): ConnectionDto {
  return {
    id: row.id,
    domain: row.domain,
    provider: row.provider,
    externalEmail: row.externalEmail,
    alias: row.alias,
    scopes: row.scopes,
    capabilities: row.capabilities,
    grantedAt: row.grantedAt.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
