import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { rdsCa } from "./certs/rds-ca.ts";

export interface DbOptions {
  /**
   * Connecting to RDS (production): the RDS-managed secret holding the
   * password. Each new connection reads its current value, so rotation never
   * needs a restart, and connections use TLS verified against RDS's CAs
   * (docs/design.md §12a).
   */
  rdsSecretArn?: string | undefined;
}

/** Creates a Drizzle client backed by a postgres.js connection pool. */
export function createDb(databaseUrl: string, options: DbOptions = {}) {
  const { rdsSecretArn } = options;
  return drizzle({
    client: postgres(databaseUrl, {
      onnotice: () => undefined,
      ...(rdsSecretArn
        ? {
            password: rdsPassword(rdsSecretArn),
            ssl: { ca: rdsCa, rejectUnauthorized: true },
          }
        : {}),
    }),
  });
}

/** Reads the password from an RDS-managed secret (`{ username, password }`). */
export function rdsPassword(
  secretArn: string,
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient(),
) {
  return async () => {
    const { SecretString } = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const { password } = JSON.parse(SecretString ?? "{}") as {
      password?: unknown;
    };
    if (typeof password !== "string")
      throw new Error("The database secret has no password.");
    return password;
  };
}

export type Db = ReturnType<typeof createDb>;

/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything queries can run on: the client itself or a transaction. */
export type DbOrTx = Db | Tx;
