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

## `alerts`: delivery and rule evaluation (review finding 50, 2026-10-03)

`alerts` had its primary key and `alerts_sent_at_idx` only. Two queries filter
it by other columns and so read the whole table: the delivery outcome
(`recordDelivery`, once per message sent) and the rule cooldown lookup
(`lastSent`, on every action of an imported leader). Migration
`0027_alerts_indexes` adds `alerts_action_user_idx (action_id, user_id)` and
`alerts_cooldown_idx (address, coin, user_id, rule_id, sent_at)`.

Measured by `apps/api/test/manual-alerts-plans.e2e-spec.ts` in an isolated
test database with 1,000,000 alerts (what 30 days hold at about 33 k a day),
"before" being the same data with the two indexes dropped inside a rolled-back
transaction. At this size the scans took 25–50 ms, not seconds: the review's
15-second statement timeout is not reached at one million rows. The cost was
the repetition: an action with 200 recipients ran the 50 ms update 200 times
(10 s of scanning for one action), now 0.1 ms each.

alerts: 1,000,000 rows

### Delivery: NotifyRepository.recordDelivery (once per message sent)
(apps/api/src/notify/notify.repository.ts)

Before (only alerts_pkey, alerts_sent_at_idx and alerts_unsent_idx):
```
Update on alerts (actual time=50.632..50.632 rows=0 loops=1)
  Buffers: shared hit=12949 read=1237 dirtied=2
  ->  Seq Scan on alerts (actual time=25.635..50.491 rows=1 loops=1)
        Filter: ((action_id = 100000) AND (user_id = 3))
        Rows Removed by Filter: 999999
        Buffers: shared hit=12944 read=1230
Planning:
  Buffers: shared hit=15
Planning Time: 0.092 ms
Execution Time: 50.680 ms
```

After (migration 0027):
```
Update on alerts (actual time=0.109..0.109 rows=0 loops=1)
  Buffers: shared hit=20 read=6 dirtied=2
  ->  Index Scan using alerts_action_user_idx on alerts (actual time=0.048..0.049 rows=1 loops=1)
        Index Cond: ((action_id = 100000) AND (user_id = 3))
        Buffers: shared hit=4 read=3
Planning:
  Buffers: shared hit=47
Planning Time: 0.190 ms
Execution Time: 0.127 ms
```

### Rule evaluation: RulesRepository.lastSent (every action of an imported leader)
(apps/api/src/rules/rules.repository.ts)

Before (only alerts_pkey, alerts_sent_at_idx and alerts_unsent_idx):
```
GroupAggregate (actual time=22.543..25.023 rows=0 loops=1)
  Group Key: user_id, rule_id
  Buffers: shared hit=12976 read=1198
  ->  Sort (actual time=22.542..25.022 rows=0 loops=1)
        Sort Key: user_id, rule_id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=12976 read=1198
        ->  Gather (actual time=22.537..25.016 rows=0 loops=1)
              Workers Planned: 2
              Workers Launched: 2
              Buffers: shared hit=12976 read=1198
              ->  Parallel Seq Scan on alerts (actual time=20.879..20.879 rows=0 loops=3)
                    Filter: ((address = 'addr-7'::text) AND (coin = 'BTC'::text) AND (user_id = ANY ('{1,2,3}'::integer[])) AND (rule_id = ANY ('{1,2,3}'::integer[])))
                    Rows Removed by Filter: 333333
                    Buffers: shared hit=12976 read=1198
Planning:
  Buffers: shared hit=33
Planning Time: 0.146 ms
Execution Time: 25.060 ms
```

After (migration 0027):
```
GroupAggregate (actual time=0.175..0.175 rows=0 loops=1)
  Group Key: user_id, rule_id
  Buffers: shared hit=25 read=2
  ->  Sort (actual time=0.174..0.174 rows=0 loops=1)
        Sort Key: user_id, rule_id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=25 read=2
        ->  Index Only Scan using alerts_cooldown_idx on alerts (actual time=0.169..0.169 rows=0 loops=1)
              Index Cond: ((address = 'addr-7'::text) AND (coin = 'BTC'::text) AND (user_id = ANY ('{1,2,3}'::integer[])) AND (rule_id = ANY ('{1,2,3}'::integer[])))
              Heap Fetches: 0
              Buffers: shared hit=25 read=2
Planning:
  Buffers: shared hit=50
Planning Time: 0.226 ms
Execution Time: 0.216 ms
```

Not changed: the alert history list (`AlertsRepository.findVisible`:
`WHERE user_id = ? ORDER BY sent_at DESC LIMIT 100`) still walks
`alerts_sent_at_idx` and filters; it stops at 100 rows and was not part of
the finding.
