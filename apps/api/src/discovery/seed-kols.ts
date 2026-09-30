/**
 * One-off KOL seed: imports a KOL CSV through the same service path as the
 * admin's CSV import (validation, upsert, audit event as "system").
 *
 *   DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api kols:seed [file] [--replace]
 *
 * `file` defaults to data/kol/copydog-kol-2026-09-30.csv (CopyDog's KOL list,
 * see docs/admin-settings.md). Re-running is safe: rows are upserted by
 * address. `--replace` also removes KOLs the file doesn't list.
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@trading-dashboard/shared/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { UnitOfWork } from "../db/unit-of-work.js";
import { KolRepository } from "./kol.repository.js";
import { KolService } from "./kol.service.js";

export const DEFAULT_KOL_FILE = fileURLToPath(new URL("../../data/kol/copydog-kol-2026-09-30.csv", import.meta.url));

export async function seedKols(databaseUrl: string, file: string, replace: boolean) {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    const db = drizzle(pool, { schema });
    const service = new KolService(new KolRepository(db), new UnitOfWork(db));
    return await service.importCsv(readFileSync(file, "utf8"), replace, null);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const replace = args.includes("--replace");
  const file = args.find((a) => !a.startsWith("--")) ?? DEFAULT_KOL_FILE;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exitCode = 1;
  } else {
    seedKols(url, resolve(file), replace)
      .then((r) => console.log(`KOLs: ${r.inserted} added, ${r.updated} updated, ${r.removed} removed, ${r.errors.length} rows skipped`))
      .catch((error: Error) => {
        console.error(`KOL seed failed: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
