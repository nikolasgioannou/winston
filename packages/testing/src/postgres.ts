import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Wait } from "testcontainers";

// Pin the multi-platform image so local and CI runs use the same database version.
const image =
  "postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995";

export async function withTestPostgres<Result>(
  run: (sql: SQL, connectionString: string) => Promise<Result>,
): Promise<Result> {
  const container = await new PostgreSqlContainer(image)
    .withDatabase("winston_test")
    .withUsername("winston_test")
    .withPassword(randomUUID())
    .withLabels({ "dev.winston.purpose": "integration-test" })
    .withWaitStrategy(
      Wait.forAll([
        Wait.forLogMessage("database system is ready to accept connections", 2),
        Wait.forListeningPorts(),
      ]),
    )
    .withStartupTimeout(90_000)
    .start();

  let sql: SQL | undefined;

  try {
    const uri = new URL(container.getConnectionUri());

    if (!["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)) {
      throw new Error("Integration databases must run on the local container runtime.");
    }

    // Never read DATABASE_URL or accept a caller-supplied database connection.
    sql = new SQL(uri.toString(), { max: 4, connectionTimeout: 10 });

    return await run(sql, uri.toString());
  } finally {
    try {
      await sql?.close();
    } finally {
      await container.stop({ remove: true, removeVolumes: true });
    }
  }
}
