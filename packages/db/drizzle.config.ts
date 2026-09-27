import { defineConfig } from "drizzle-kit";
import { loadDbConfig } from "./src/config.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: loadDbConfig().DATABASE_URL },
});
