import { setTimeout } from "node:timers/promises";
import type { createDatabase, OwnerTransaction } from "../database/database";
import type { createCredentialCipher } from "../credentials";
import { providerGrantSchema } from "@winston/contracts/credentials";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { GoogleOAuth } from "./oauth";
import { GoogleAccessError } from "./errors";

async function publishHealth(scope: OwnerTransaction, connection: Connection) {
  await scope.events.publish({
    key: `${connection.id}:${String(connection.revision)}`,
    type: "connection.health",
    payload: {
      connectionId: connection.id,
      revision: connection.revision,
      status: connection.status,
    },
    destinations: ["connection-runtime", "conversation-updates"],
  });
}

export function createGoogleGrants({
  database,
  cipher,
  oauth,
}: {
  database: ReturnType<typeof createDatabase>;
  cipher: ReturnType<typeof createCredentialCipher>;
  oauth: GoogleOAuth;
}) {
  async function access(ownerId: string, id: string, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    try {
      while (!deadline.aborted) {
        const result = await database.transaction(ownerId, async (scope) => {
          if (!(await scope.connections.tryRefreshLock(id))) return { kind: "busy" } as const;
          const connection = await scope.connections.find(id);
          const credential = await scope.credentials.find(id);
          if (!connection) return { kind: "disconnected" } as const;
          if (connection.status !== "connected") return { kind: connection.status };
          if (!credential?.encrypted) return { kind: "reconnect" } as const;
          const grant = cipher.decrypt(credential, credential.encrypted);
          if (Date.parse(grant.expiresAt) > Date.now() + 60_000)
            return { kind: "ready", grant, revision: credential.revision } as const;
          try {
            const refreshed = providerGrantSchema.parse(await oauth.refresh(grant, deadline));
            if (Date.parse(refreshed.expiresAt) <= Date.now() + 30_000)
              throw new GoogleAccessError("unavailable");
            const revision = credential.revision + 1;
            await scope.credentials.put(
              id,
              credential.revision,
              cipher.encrypt({ ownerId, id, provider: "google", revision }, refreshed),
            );
            // Credential CAS holds the owner lock; preserve any calendar edits made during refresh.
            const current = await scope.connections.find(id);
            if (!current) throw new GoogleAccessError("disconnected");
            const status = googleScopes[current.service].every((item) =>
              refreshed.scopes.includes(item),
            )
              ? "connected"
              : "limited";
            if (
              status !== current.status ||
              JSON.stringify([...refreshed.scopes].sort()) !==
                JSON.stringify([...current.scopes].sort())
            ) {
              await publishHealth(
                scope,
                await scope.connections.setHealth(id, current.revision, status, refreshed.scopes),
              );
            }
            return status === "connected"
              ? ({ kind: "ready", grant: refreshed, revision } as const)
              : ({ kind: "limited" } as const);
          } catch (error) {
            if (!(error instanceof GoogleAccessError) || error.kind !== "reconnect") throw error;
            const updated = await scope.connections.setHealth(id, connection.revision, "reconnect");
            await scope.credentials.revoke(id, credential.revision);
            await publishHealth(scope, updated);
            return { kind: "reconnect" } as const;
          }
        });
        if (result.kind === "ready") return result;
        if (result.kind !== "busy") throw new GoogleAccessError(result.kind);
        await setTimeout(100, undefined, { signal: deadline });
      }
    } catch (error) {
      if (error instanceof GoogleAccessError) throw error;
      throw new GoogleAccessError("unavailable");
    }
    throw new GoogleAccessError("unavailable");
  }

  async function disconnect(ownerId: string, id: string, revision: number) {
    return database.transaction(ownerId, async (scope) => {
      const updated = await scope.connections.setHealth(id, revision, "disconnected");
      const credential = await scope.credentials.find(id);
      if (credential?.encrypted) await scope.credentials.revoke(id, credential.revision);
      await publishHealth(scope, updated);
      return updated;
    });
  }

  async function rejected(ownerId: string, id: string, revision: number) {
    await database.transaction(ownerId, async (scope) => {
      const connection = await scope.connections.find(id);
      if (!connection) return;
      const updated = await scope.connections.setHealth(id, connection.revision, "reconnect");
      const credential = await scope.credentials.find(id);
      if (!credential?.encrypted || credential.revision !== revision)
        throw new GoogleAccessError("unavailable");
      await scope.credentials.revoke(id, revision);
      await publishHealth(scope, updated);
    });
  }
  return { access, disconnect, rejected };
}
