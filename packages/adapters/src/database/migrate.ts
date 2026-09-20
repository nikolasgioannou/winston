import { migrateDatabase } from "./migrations";

const connectionString = process.env.DIRECT_DATABASE_URL;

if (!connectionString) {
  throw new Error("Set DIRECT_DATABASE_URL to the target database's direct connection URL.");
}

try {
  await migrateDatabase(connectionString);
  console.log("Database migrations applied and schema verified.");
} catch {
  console.error(
    "Migration failed. Check direct connectivity and immutable migration history before retrying.",
  );
  process.exitCode = 1;
}
