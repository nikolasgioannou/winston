type Environment = Record<string, string | undefined>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const localParameters = new Set(["sslmode", "application_name", "connect_timeout"]);

export function isProductionEnvironment(environment: Environment) {
  if (![undefined, "development", "test", "production"].includes(environment.NODE_ENV))
    throw new Error("NODE_ENV must be development, test, or production.");
  return environment.NODE_ENV === "production";
}

export function validateDatabaseEnvironment(
  environment: Environment,
  fields: readonly ("DATABASE_URL" | "DIRECT_DATABASE_URL")[],
) {
  const production = isProductionEnvironment(environment);
  const targets: URL[] = [];
  for (const field of fields) {
    const value = environment[field];
    let target: URL;
    try {
      if (!value) throw new Error();
      target = new URL(value);
      if (
        !["postgres:", "postgresql:"].includes(target.protocol) ||
        !target.hostname ||
        !target.username ||
        target.pathname.length < 2 ||
        target.hash
      )
        throw new Error();
    } catch {
      throw new Error(
        `${field} must be a PostgreSQL URL with an explicit host, user, and database.`,
      );
    }
    if (!production) {
      if (!loopbackHosts.has(target.hostname))
        throw new Error(
          `${field} must target loopback PostgreSQL for local development. Production databases cannot be used by local workers.`,
        );
      for (const key of target.searchParams.keys()) {
        if (!localParameters.has(key))
          throw new Error(
            `${field} contains a connection parameter that is not allowed in local development.`,
          );
      }
    }
    targets.push(target);
  }
  if (!production && targets.length > 1) {
    const [first] = targets;
    if (
      targets.some(
        (target) =>
          target.pathname !== first?.pathname || (target.port || "5432") !== (first.port || "5432"),
      )
    )
      throw new Error(
        "DATABASE_URL and DIRECT_DATABASE_URL must use the same local database and port.",
      );
  }
}
