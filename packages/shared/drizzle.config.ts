import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the M1 scaffold.
 *
 * `drizzle-kit generate` only diffs against the schema file + the migrations
 * folder and does not need a live database connection. `dbCredentials.url`
 * is only read by commands that do connect (e.g. `migrate`, `push`, `studio`),
 * which is why it's safe to point at an env var that may be unset at
 * generate-time.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/db.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder",
  },
  strict: true,
  verbose: true,
});
