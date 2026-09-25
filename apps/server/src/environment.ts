import { isProductionEnvironment, validateDatabaseEnvironment } from "@winston/adapters/database";

export function validateRuntimeEnvironment(environment: Record<string, string | undefined>) {
  const production = isProductionEnvironment(environment);
  validateDatabaseEnvironment(
    environment,
    environment.DIRECT_DATABASE_URL ? ["DATABASE_URL", "DIRECT_DATABASE_URL"] : ["DATABASE_URL"],
  );
  if (!production && (environment.FLY_MACHINE_ID || environment.FLY_APP_NAME))
    throw new Error(
      "Fly services must explicitly use NODE_ENV=production. Local development must not inherit Fly runtime configuration.",
    );
  for (const field of ["BETTER_AUTH_URL", "WEB_ORIGIN"] as const) {
    let origin: URL;
    try {
      origin = new URL(environment[field] ?? "");
      if (origin.origin !== environment[field]) throw new Error();
    } catch {
      throw new Error(`${field} must be an explicit origin.`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (
      production
        ? origin.protocol !== "https:" || loopback
        : origin.protocol !== "http:" || !loopback
    )
      throw new Error(
        `${field} must use ${production ? "a public HTTPS origin in production" : "a loopback HTTP origin in local development"}.`,
      );
  }
  if (
    environment.GOOGLE_CONNECTOR_CLIENT_ID &&
    environment.GOOGLE_CONNECTOR_CLIENT_ID === environment.GOOGLE_CLIENT_ID
  )
    throw new Error(
      "GOOGLE_CONNECTOR_CLIENT_ID must differ from GOOGLE_CLIENT_ID. Connections and sign-in use separate OAuth clients.",
    );
}
