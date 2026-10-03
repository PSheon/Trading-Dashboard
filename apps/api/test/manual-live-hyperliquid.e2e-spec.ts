import { WatcherRepository } from '../src/watcher/watcher.repository.js';
import { FeedActionsRepository } from '../src/watcher/feed-actions.repository.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { FillSyncRepository } from '../src/watcher/fill-sync.repository.js';
import { AccountStateRepository } from '../src/watcher/account-state.repository.js';
import { testConfig } from './config-test-utils.js';
import { writeFileSync } from 'node:fs';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { actions, fills, leaders } from '@trading-dashboard/shared/database';
import { describe, expect, it } from 'vitest';

import { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { AccountStateService } from '../src/watcher/account-state.service.js';
import { ACTION_CREATED_EVENT } from '../src/watcher/action-created.event.js';
import { FeedActionsService } from '../src/watcher/feed-actions.service.js';
import { FillSyncService } from '../src/watcher/fill-sync.service.js';
import { TradeFeedService } from '../src/watcher/trade-feed.service.js';
import { WatcherService } from '../src/watcher/watcher.service.js';
import { closeTestDb, getTestDb, truncateAll } from './db-test-utils.js';

/**
 * MANUAL, against live Hyperliquid mainnet and a local Postgres; not part of
 * `pnpm test`. Run with:
 *
 *   E2E_RUN_LIVE=1 E2E_REQUIRE_ACTIVITY=1 \
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5433/postgres \
 *     node scripts/test-api-isolated.mjs --config vitest.config.e2e.ts \
 *       test/manual-live-hyperliquid.e2e-spec.ts
 *
 * Picks the most active addresses from recent BTC/ETH/SOL/HYPE trades as
 * leaders, runs the real trade feed for 90 s, then lets the slow path
 * (background fill storage and corrections) drain. Checks that every stored
 * fill is unique per (address, tid) and that no fill is in two actions, and
 * reports how long it took from trade time to action, and how often the
 * fast path's actions matched their real fills. Live activity varies, so it
 * asserts consistency. E2E_REQUIRE_ACTIVITY=1 also requires new signals and
 * complete fill reconciliation, so a quiet or disconnected feed cannot pass.
 */
const RUN_MS = Number(process.env.E2E_RUN_MS ?? 90_000);
/** After the feed stops: first confirm (2 s), its retries (5/15/60 s, at
 * least 15 s apart) and the background queue. */
const DRAIN_MS = Number(process.env.E2E_DRAIN_MS ?? 120_000);

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

describe.skipIf(process.env.E2E_RUN_LIVE !== '1')(
  'live Hyperliquid + real Postgres (manual)',
  () => {
    it(
      'detects live trades of watched addresses through the trades feed',
      { timeout: RUN_MS + DRAIN_MS + 60_000 },
      async () => {
        const db = getTestDb();
        let activeWatcher: WatcherService | undefined;
        let activeFeed: TradeFeedService | undefined;
        try {
          await truncateAll(db);

          const budgeter = new RequestBudgeterService(testConfig());
          const info = new HyperliquidInfoClient(testConfig(), budgeter);
          const counts = new Map<string, number>();
          for (const coin of ['BTC', 'ETH', 'SOL', 'HYPE']) {
            const res = await fetch('https://api.hyperliquid.xyz/info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'recentTrades', coin }),
              signal: AbortSignal.timeout(10_000),
              redirect: 'error',
            });
            if (!res.ok)
              throw new Error(`Public recentTrades failed (${res.status})`);
            for (const t of (await res.json()) as Array<{ users: string[] }>) {
              for (const u of t.users) counts.set(u, (counts.get(u) ?? 0) + 1);
            }
          }
          // E2E_SKIP / E2E_WATCH pick a slice of the ranking: the top ranks are
          // market makers trading every second (a budget stress test); lower
          // ranks trade more like the leaders this app is for.
          const skip = Number(process.env.E2E_SKIP ?? 0);
          const take = Number(process.env.E2E_WATCH ?? 10);
          let busySet = new Set<string>();
          let watched = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(skip, skip + take)
            .map(([a]) => a);
          if (process.env.E2E_SOURCE === 'leaderboard') {
            // The real use case: the official leaderboard's top traders by monthly
            // PnL, the same population as a CopyDog top-100 export.
            const response = await fetch(
              'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
              {
                signal: AbortSignal.timeout(15_000),
                redirect: 'error',
              },
            );
            if (!response.ok)
              throw new Error(`Public leaderboard failed (${response.status})`);
            const board = (await response.json()) as {
              leaderboardRows: Array<{
                ethAddress: string;
                windowPerformances: Array<[string, { pnl: string }]>;
              }>;
            };
            const monthPnl = (r: (typeof board.leaderboardRows)[number]) =>
              Number(
                r.windowPerformances.find(([w]) => w === 'month')?.[1].pnl ?? 0,
              );
            const leaders = board.leaderboardRows
              .sort((a, b) => monthPnl(b) - monthPnl(a))
              .slice(skip, skip + take)
              .map((r) => r.ethAddress.toLowerCase());
            // E2E_ADD_BUSY adds that many of the busiest recent traders (market
            // makers), to check quiet leaders aren't starved by them.
            const busy = [...counts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([a]) => a)
              .filter((a) => !leaders.includes(a))
              .slice(0, Number(process.env.E2E_ADD_BUSY ?? 0));
            busySet = new Set(busy);
            watched = [...leaders, ...busy];
          }
          await db
            .insert(leaders)
            .values(
              watched.map((address) => ({
                chain: 'hyperliquid',
                address,
                active: true,
                tier: 'B' as const,
              })),
            );

          // Alerts are tagged by path: fast (feed) or slow (fills the feed missed).
          // Trades from before the feed started (the subscription replays up to
          // 60 s of them) aren't "just traded" and are counted apart.
          interface Alert {
            address: string;
            ms: number;
            path: 'fast' | 'slow';
            beforeStart: boolean;
          }
          const alerts: Alert[] = [];
          let startedAt = Infinity;
          const tagged = (path: Alert['path']) => {
            const emitter = new EventEmitter2();
            emitter.on(
              ACTION_CREATED_EVENT,
              (row: { ts: Date; address: string }) =>
                alerts.push({
                  address: row.address,
                  ms: Date.now() - row.ts.getTime(),
                  path,
                  beforeStart: row.ts.getTime() < startedAt,
                }),
            );
            return emitter;
          };
          const accounts = new AccountStateService(
            info,
            new AccountStateRepository(db),
          );
          const fillSync = new FillSyncService(
            testConfig(),
            info,
            new FillSyncRepository(db),
            new UnitOfWork(db),
            accounts,
            tagged('slow'),
          );
          const feed = new TradeFeedService(testConfig(), info);
          activeFeed = feed;
          const feedActions = new FeedActionsService(
            testConfig(),
            new FeedActionsRepository(),
            new UnitOfWork(db),
            accounts,
            tagged('fast'),
          );
          const watcher = new WatcherService(
            testConfig(),
            feed,
            fillSync,
            accounts,
            feedActions,
            new WatcherRepository(db),
          );
          activeWatcher = watcher;

          await watcher.refreshWatched();
          startedAt = Date.now();
          await feed.start({
            onTrade: (a, t) => watcher.onTrade(a, t),
            onGap: (since) => watcher.onGap(since),
          });
          await new Promise((r) => setTimeout(r, RUN_MS));
          const status = feed.status();
          const budgetDuringRun = budgeter.introspect();
          feed.stop();
          const alertsDuringRun = alerts.length;
          await new Promise((r) => setTimeout(r, DRAIN_MS)); // let confirms and their retries finish
          watcher.stop();

          const storedFills = await db.select().from(fills);
          const storedActions = await db.select().from(actions);
          const keys = new Set(storedFills.map((f) => `${f.address}:${f.tid}`));
          const actionTids = storedActions.flatMap((a) =>
            a.fillIds.map((tid) => `${a.address}:${tid}`),
          );
          const live = alerts.filter((a) => !a.beforeStart);
          const ms = (list: Alert[]) =>
            list.map((a) => a.ms).sort((x, y) => x - y);
          const stats = (list: Alert[]) => {
            const v = ms(list);
            return {
              n: v.length,
              p50: pct(v, 0.5),
              p90: pct(v, 0.9),
              max: v[v.length - 1],
            };
          };
          const leader = live.filter((a) => !busySet.has(a.address));
          const busy = live.filter((a) => busySet.has(a.address));
          const heartbeat = watcher.getHeartbeat();
          const summary = {
            source:
              process.env.E2E_SOURCE === 'leaderboard'
                ? 'monthlyLeaderboard'
                : 'recentActiveTraders',
            startedAt: new Date(startedAt).toISOString(),
            runMs: RUN_MS,
            drainMs: DRAIN_MS,
            watched: watched.length,
            markets: status.markets,
            sockets: `${status.socketsOpen}/${status.socketsTotal}`,
            fills: storedFills.length,
            actions: storedActions.length,
            actionsWithAllFillsStored: storedActions.filter((a) =>
              a.fillIds.every((tid) => keys.has(`${a.address}:${tid}`)),
            ).length,
            alertsEmitted: alerts.length,
            alertsOnTradesBeforeStart: alerts.length - live.length,
            alertsEmittedAfterFeedStopped: alerts.length - alertsDuringRun,
            all: stats(live),
            leader: stats(leader),
            leaderFast: stats(leader.filter((a) => a.path === 'fast')),
            leaderSlow: stats(leader.filter((a) => a.path === 'slow')),
            busy: stats(busy),
            busyFast: stats(busy.filter((a) => a.path === 'fast')),
            busySlow: stats(busy.filter((a) => a.path === 'slow')),
            leaderAddressesWithAlerts: new Set(leader.map((a) => a.address))
              .size,
            fastPath: heartbeat.fastPath,
            fillsUnavailable: heartbeat.fillsUnavailable.map(
              (u) => `${u.address}:${u.missedTrades}`,
            ),
            leaderLatencyMs: ms(leader),
            leaderSlowAlerts: leader
              .filter((a) => a.path === 'slow')
              .map((a) => `${a.address}:${a.ms}`),
            budget: budgeter.introspect(),
            budgetDuringRun,
          };
          // Vitest hides console output of passing tests; write it where it can be read.
          console.log(summary);
          if (process.env.E2E_SUMMARY_FILE)
            writeFileSync(
              process.env.E2E_SUMMARY_FILE,
              JSON.stringify(summary, null, 2),
            );

          expect(status.markets).toBeGreaterThan(100);
          expect(status.socketsOpen).toBe(status.socketsTotal);
          expect(keys.size).toBe(storedFills.length);
          // Fast and slow path together never make two actions of one fill.
          expect(new Set(actionTids).size).toBe(actionTids.length);
          if (process.env.E2E_REQUIRE_ACTIVITY === '1') {
            expect(
              live.length,
              'No new live trading signals observed',
            ).toBeGreaterThan(0);
            expect(storedFills.length).toBeGreaterThan(0);
            expect(
              summary.actionsWithAllFillsStored,
              'Unreconciled action fills after drain',
            ).toBe(storedActions.length);
          }
        } finally {
          activeFeed?.stop();
          activeWatcher?.stop();
          await closeTestDb();
        }
      },
    );
  },
);
