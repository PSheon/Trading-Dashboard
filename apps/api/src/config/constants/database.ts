/**
 * The main database pool's default size per process (DATABASE_POOL_MAX overrides it, 2–200).
 * Postgres's max_connections is 100 on Railway (3 for superusers): the sum of every process's
 * pool, the worker leases and a deploy's overlap must stay under 97 (docs/railway-deploy.md,
 * "Database connections"). pg opens connections only on demand and closes them after 10 s idle,
 * so a cap costs nothing until it is used: it bounds the worst case, not the steady state.
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

/** basis: guessed — cost reduction 2026-10-22 (§1 #7): the api's dedicated connections counted in the code, with headroom; verify: pg_stat_activity per application_name ('td-api') at a gate's busiest minute
 * Held for the process's life: three LISTEN relays (SettingsRelay, ActionRelayListener,
 * CopyFeedListener). Held while one runs: the terminal settlement loop (on the api unless
 * API_TERMINAL_SETTLEMENT=off) takes a claim and a risk-scope connection and is refused below
 * three free (CopyLiveSettlementClaims). 3 + 2 + one pooled statement of that settlement leave
 * 4 for request handlers' short queries. Was 20 (2026-10-12).
 */
export const DATABASE_POOL_MAX_API = 10;

/** basis: guessed — cost reduction 2026-10-22 (§1 #7): the copy worker's dedicated connections counted in the code, doubled for headroom on the money path; verify: pg_stat_activity per application_name ('td-worker-copy') at a gate's busiest minute
 * Held for the process's life: two LISTEN connections (SettingsRelay, CopySetupDueListener).
 * Held while one runs, each beside one pooled statement at a time: the live engine's drain
 * (serial: one order, stop, close or settlement at a time) takes the order lock (journal) and
 * the risk scope = 2 + 1; the terminal settlement loop (serial over orders) a claim and a risk
 * scope = 2 + 1; setup drives (one per woken setup, in parallel) use pooled transactions only,
 * ~1 each with two or three at once; the funding monitor, watcher and trade feed ~2. About 13 at
 * once; 20 keeps a live order from waiting on the pool (an order's evidence has 5 s). The
 * proposal's 15 left two spare at that count. Was 30 (2026-10-12).
 */
export const DATABASE_POOL_MAX_COPY_WORKER = 20;

/** basis: guessed — cost reduction 2026-10-22 (§1 #7): the read worker runs no money path and holds one LISTEN connection (SettingsRelay); verify: pg_stat_activity per application_name ('td-worker-read') and its jobs' "timeout exceeded when trying to connect" errors
 * Its jobs (crons, discovery, cohorts, snapshots, paper copy, outbox, retention, archive) run
 * independently, each with short statements; one waiting on the pool waits up to 3 s
 * (connectionTimeoutMillis) and is retried on its next tick. Was 30 (2026-10-12).
 */
export const DATABASE_POOL_MAX_READ_WORKER = 10;

/** basis: derived — DATABASE_POOL_MAX_COPY_WORKER + DATABASE_POOL_MAX_READ_WORKER: a worker of role `all` runs both
 * One worker that holds both leases (local development; a deployment before the split).
 */
export const DATABASE_POOL_MAX_WORKER = DATABASE_POOL_MAX_COPY_WORKER + DATABASE_POOL_MAX_READ_WORKER;
