# Query performance evidence

Leader summaries now process at most 200 addresses per batch. Metadata uses one
SQL round trip; complete trades are reconstructed once for the whole batch and
shared by 7d/30d PnL, win rate and average hold-time calculations. Fill lookups
remain keyed by address and tid; counterparty fills may share a tid. Large fill
ID lists are split at 20,000 bind parameters. Ordering now breaks action timestamp
ties by id. No cache lifetime or portfolio semantics changed.

A real PostgreSQL regression with 12 leaders and complete trips previously
issued 133 query-builder calls; it now issues 4. Empty histories retain null
rates/hold times and zero PnL. Position count uses the most recent equity
snapshot, so a historical position is not shown after a newer flat snapshot.

Migration 0010 adds actions(chain,address,ts,id) and list-items(address,list_id)
indexes. `scripts/query-plan-smoke.mjs` builds 100,000 artificial actions in a
random disposable DB and prints EXPLAIN ANALYZE/BUFFERS JSON. One local run of
the latest-action query changed from a sequential scan (99,900 rows rejected,
1,429 shared buffer hits, 8.254 ms) to the new index (104 hits, 0.074 ms). These
are synthetic warm/local results, not a production latency promise. PostgreSQL
may choose different plans at different cardinalities.

Remaining limits: full historical round-trip reconstruction still reads all
relevant actions/fills and the legacy leaders route is not paginated. The modern
/explore route already has bounded pagination. Large histories should use
incremental aggregates after measuring real workload. Single-address analytics
and notifications retain their original APIs. Cold trader profile/activity and
TWAP ingestion behavior from concurrent Claude commits are preserved.

The migration uses ordinary CREATE INDEX inside Drizzle's migration transaction;
large production tables may require a reviewed CONCURRENTLY rollout outside that
transaction and a suitable maintenance plan. No production index was created or
production data benchmarked. The pg 8 driver warns about a few existing parallel
queries on one transaction connection; do not upgrade to pg 9 before serializing
those paths and testing notification delivery.
