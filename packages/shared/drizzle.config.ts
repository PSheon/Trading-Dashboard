import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Match apps/api's local setup. Explicit shell/platform values win.
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Schema generation is offline; connection commands must never silently
// choose a different database when DATABASE_URL is missing.
const databaseUrl = process.env.DATABASE_URL;
const needsDatabase = process.argv.some((arg) => ["migrate", "push", "studio", "pull", "introspect"].includes(arg));
if (needsDatabase && !databaseUrl) throw new Error("DATABASE_URL is required for database commands");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/db.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl ?? "",
  },
  strict: true,
  verbose: true,
});
