// Verifies, read-only, that the rows a database already holds satisfy the
// CHECK constraints of a migration, before that migration is applied.
//
//   DATABASE_URL=postgres://… node scripts/verify-check-constraints.mjs [migration.sql ...] [--assume table.column=sql ...] [--json]
//   node scripts/verify-check-constraints.mjs --env        (reads DATABASE_URL from the repository's .env)
//
// For every `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` it counts the rows for
// which the expression is false (NULL passes, as in Postgres) inside one
// `BEGIN READ ONLY` transaction, and prints up to three offending rows'
// values. Nothing is written; the connection URL is never printed.
//
// A column or table an earlier pending migration adds does not exist yet:
// `--assume table.column=<default>` checks the constraint with the value
// the column will have (its default), and a table that does not exist has
// no rows. Exit status 1 when any constraint is violated.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const json = args.includes("--json");
if (args.includes("--env")) {
  const env = `${root}.env`;
  if (existsSync(env)) process.loadEnvFile(env);
}
const assume = new Map();
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--assume") { const [column, ...value] = args[++i].split("="); assume.set(column, value.join("=")); }
  else if (!args[i].startsWith("--")) files.push(args[i]);
}
if (files.length === 0) {
  const dir = `${root}packages/shared/drizzle/`;
  for (const name of readdirSync(dir).sort()) if (/\.sql$/.test(name) && /ADD CONSTRAINT "[^"]+" CHECK/.test(readFileSync(dir + name, "utf8"))) files.push(dir + name);
}

/** Every CHECK a migration file adds: `ALTER TABLE … ADD CONSTRAINT` and those inside `CREATE TABLE`. */
export function parseChecks(sql) {
  const out = [];
  for (const statement of sql.split("--> statement-breakpoint")) {
    const alter = /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" CHECK \(([\s\S]*)\);?\s*$/.exec(statement.trim());
    if (alter) { out.push({ table: alter[1], name: alter[2], expression: alter[3] }); continue; }
    const create = /CREATE TABLE "([^"]+)"/.exec(statement);
    if (create) for (const m of statement.matchAll(/CONSTRAINT "([^"]+)" CHECK \((.*)\)\s*$/gm)) out.push({ table: create[1], name: m[1], expression: m[2] });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required (or --env)"); process.exit(2); }
  const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000 });
  await client.connect();
  const results = [];
  try {
    await client.query("BEGIN READ ONLY");
    for (const file of files) {
      for (const check of parseChecks(readFileSync(file, "utf8"))) {
        let expression = check.expression;
        const assumed = [];
        for (const [column, value] of assume) {
          const [table, name] = column.split(".");
          const quoted = `"${table}"."${name}"`;
          if (table === check.table && expression.includes(quoted)) { expression = expression.replaceAll(quoted, `(${value})`); assumed.push(`${column}=${value}`); }
        }
        const result = { file: file.replace(root, ""), ...check, rows: null, violations: null, samples: [], note: assumed.length ? `assumed ${assumed.join(", ")}` : null };
        await client.query("SAVEPOINT one");
        try {
          const { rows } = await client.query(`SELECT count(*)::bigint AS rows, count(*) FILTER (WHERE NOT (${expression}))::bigint AS bad FROM "${check.table}"`);
          result.rows = Number(rows[0].rows);
          result.violations = Number(rows[0].bad);
          if (result.violations > 0) result.samples = (await client.query(`SELECT * FROM "${check.table}" WHERE NOT (${expression}) LIMIT 3`)).rows;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT one");
          if (error.code === "42P01") { result.rows = 0; result.violations = 0; result.note = "table does not exist yet (created by a pending migration): no rows"; }
          else if (error.code === "42703") { result.note = `not checked: ${error.message} (pass --assume ${check.table}.<column>=<default>)`; }
          else throw error;
        }
        results.push(result);
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
  const violated = results.filter((r) => r.violations > 0);
  const unchecked = results.filter((r) => r.violations === null);
  if (json) console.log(JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else {
    for (const r of results) console.log(`${r.violations === null ? "SKIP" : r.violations > 0 ? "FAIL" : "ok  "} ${r.table}.${r.name}: ${r.violations ?? "?"} of ${r.rows ?? "?"} rows violate${r.note ? ` (${r.note})` : ""}`);
    for (const r of violated) console.log(`\n${r.name}: CHECK (${r.expression})\n${JSON.stringify(r.samples, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 1500)}`);
    console.log(`\n${results.length} constraints: ${results.length - violated.length - unchecked.length} satisfied, ${violated.length} violated, ${unchecked.length} not checked`);
  }
  process.exitCode = violated.length > 0 || unchecked.length > 0 ? 1 : 0;
}
