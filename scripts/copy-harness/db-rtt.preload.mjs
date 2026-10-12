// Copy harness — loaded with `node --import` by stack.mjs when the profile sets
// COPY_HARNESS_DB_RTT_MS (TEST ONLY; see db-rtt.mjs). pg resolves from apps/api,
// the same module instance the api's `import { Pool } from "pg"` gets.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { installDbRtt, rttFromEnv } from "./db-rtt.mjs";

const ms = rttFromEnv();
if (ms > 0) {
  const pg = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"))("pg");
  installDbRtt(pg.Client, ms);
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "copy_harness_db_rtt", ms }));
}
