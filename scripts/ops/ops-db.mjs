/**
 * Shared by the read-only ops scripts in this directory (copy-acceptance.mjs,
 * site-freshness.mjs): argument parsing, SQL literal rendering for `--sql-only`,
 * and one read-only query session.
 *
 * The session is `BEGIN READ ONLY` … `ROLLBACK`: a script here never writes,
 * and a statement that tries to is refused by PostgreSQL itself. The connection
 * string (DATABASE_URL) is never printed; errors are reported by code and
 * message only.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/** Reads `--name value` and `--flag` arguments; `spec` maps a name to "value" or "flag". Unknown names throw. */
export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (!kind) throw new Error(`unknown option --${name}`);
    if (kind === "flag") { out[name] = true; continue; }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

/** A parameter as a SQL literal, for `--sql-only` output. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return String(value); }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** `$1`, `$2`, … replaced by their literals (highest index first, so `$1` never eats `$10`). */
export function inlineParams(text, params) {
  let out = text;
  for (let i = params.length; i >= 1; i--) out = out.replaceAll(`$${i}`, sqlLiteral(params[i - 1]));
  return out;
}

/** The statement as a read-only psql script: the same query the script runs, to pipe into any psql that reaches the database. */
export function readOnlyScript(text, params) {
  return `BEGIN READ ONLY;\n${inlineParams(text, params)};\nROLLBACK;\n`;
}

/**
 * Runs one statement in a read-only transaction and returns its rows. `pg` is
 * apps/api's (scripts/test-database.mjs resolves it the same way); loaded here,
 * not at import, so the pure helpers and `--sql-only` work without node_modules.
 */
export async function readOnlyQuery(databaseUrl, text, params) {
  const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl, application_name: "ops-readonly", statement_timeout: 120_000, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* the session is closed below either way */ }
    await client.end();
  }
}

/** The one JSON `report` column of a statement, from the database or from a file written by psql (`--input`, `-` for stdin). */
export async function loadReport({ databaseUrl, input, text, params }) {
  if (input !== undefined) {
    const raw = readFileSync(input === "-" ? 0 : input, "utf8").trim();
    return JSON.parse(raw);
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (or pass --input <file> with the JSON psql printed, or --sql-only)");
  const rows = await readOnlyQuery(databaseUrl, text, params);
  const report = rows[0]?.report;
  if (report === undefined) throw new Error("the statement returned no report row");
  return typeof report === "string" ? JSON.parse(report) : report;
}

/** An ISO timestamp argument as milliseconds, or a usage error. */
export function parseTime(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`--${name} must be an ISO 8601 timestamp`);
  return ms;
}

/** Message and code only: never the connection string a driver error could carry. */
export function describeError(error) {
  if (error instanceof Error) {
    const code = typeof error.code === "string" ? ` (${error.code})` : "";
    return `${error.message}${code}`;
  }
  return String(error);
}
