// One in-memory DuckDB per process, used as a query engine over Parquet files.
// Nothing is stored in DuckDB itself, so the CLI and the web server can run at
// the same time without fighting over a database lock.

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

const holder = globalThis as unknown as { __smartwalletDuck?: Promise<DuckDBInstance> };

function instance(): Promise<DuckDBInstance> {
  holder.__smartwalletDuck ??= DuckDBInstance.create(":memory:");
  return holder.__smartwalletDuck;
}

export async function withConnection<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
  const connection = await (await instance()).connect();
  try {
    return await fn(connection);
  } finally {
    connection.closeSync();
  }
}

export type Row = Record<string, unknown>;

export async function queryRows(sql: string, connection?: DuckDBConnection): Promise<Row[]> {
  const run = async (c: DuckDBConnection) => (await c.runAndReadAll(sql)).getRowObjectsJS() as Row[];
  return connection ? run(connection) : withConnection(run);
}

export async function execSql(sql: string, connection?: DuckDBConnection): Promise<void> {
  if (connection) await connection.run(sql);
  else await withConnection(async (c) => void (await c.run(sql)));
}

/** A SQL string literal. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A SQL list of string literals, e.g. for IN. Never empty. */
export function litList(values: readonly string[]): string {
  return values.length ? values.map(lit).join(", ") : "NULL";
}
