import { createOwnerAuth } from "@winston/adapters/auth";
import { createDatabase } from "@winston/adapters/database";
import { createOwnerRouter } from "./http/owner";
import { readAuthConfig } from "./auth-config";
import { readConfig } from "./config";
import { startServer } from "./host";

const config = readAuthConfig(process.env);
const database = createDatabase({
  connectionString: config.connectionString,
  onConnectionError: () => {
    console.error("Application database connection lost.");
  },
});

try {
  await database.assertCompatible();
} catch {
  await database.close();
  console.error("Database startup failed. Check connectivity and apply the release migrations.");
  process.exit(1);
}

const auth = createOwnerAuth(config.auth, config.connectionString);
const owner = createOwnerRouter(database);

const host = startServer(readConfig(process.env), {
  readiness: async () => {
    await database.assertCompatible();

    return true;
  },
  authHandler: (request) => auth.handle(request),
  ownerOrigin: config.auth.webOrigin,
  groups: {
    owner: {
      router: owner,
      async authenticate(request) {
        const session = await auth.owner(request);

        if (!session) {
          return null;
        }

        await database.transaction(session.ownerId, (scope) => scope.owners.ensure());

        return { kind: "owner", ownerId: session.ownerId };
      },
    },
  },
  log: (entry) => {
    console.log(JSON.stringify(entry));
  },
});

function shutdown() {
  host
    .stop()
    .then(async () => {
      await Promise.all([auth.close(), database.close()]);
    })
    .catch(() => {
      console.error("Server shutdown failed.");
      process.exitCode = 1;
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
