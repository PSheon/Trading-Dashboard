import { Logger } from "@nestjs/common";
import type { ActionKind } from "@trading-dashboard/shared";

import type { HlUserFill } from "../hyperliquid/types.js";

const logger = new Logger("ActionClassifier");

/**
 * Hyperliquid `dir` → (category, side) mapping. Verified live against the
 * real API (`userFillsByTime` against a real address, 2026-09-29) — every
 * value in this map was actually observed in a live response, not assumed
 * from memory/training data:
 *   perps: "Open Long", "Open Short", "Close Long", "Close Short",
 *          "Long > Short" (also expect the symmetric "Short > Long")
 *   spot:  "Buy", "Sell", "Spot Dust Conversion"
 *
 * §11 決策紀錄 "市場範圍" restricts this v1 to perps only ("只看 perps，不看
 * spot") — spot dir values are recognized-but-out-of-scope and silently
 * skipped (not an error). Anything NOT in this table is a genuinely
 * unrecognized value: per the task spec, that is logged and skipped rather
 * than guessed at, so a future Hyperliquid schema change fails loud instead
 * of silently mis-classifying.
 */
type DirCategory = "open" | "close" | "flip";
type Side = "long" | "short";

const PERPS_DIR: Record<string, { category: DirCategory; side: Side }> = {
  "Open Long": { category: "open", side: "long" },
  "Open Short": { category: "open", side: "short" },
  "Close Long": { category: "close", side: "long" },
  "Close Short": { category: "close", side: "short" },
  "Long > Short": { category: "flip", side: "short" },
  "Short > Long": { category: "flip", side: "long" },
};

const SPOT_DIRS = new Set(["Buy", "Sell", "Spot Dust Conversion"]);

/** Spot pairs are reported with a coin name like "PURR/USDC" (verified
 * live) — a second, cheap signal alongside the `dir` check below. */
function looksLikeSpotCoin(coin: string): boolean {
  return coin.includes("/");
}

/** True for a fill this v1 (perps-only) should not ingest at all. */
export function isOutOfScopeSpotFill(fill: HlUserFill): boolean {
  return SPOT_DIRS.has(fill.dir) || looksLikeSpotCoin(fill.coin);
}

export interface PositionStateLookup {
  /** Did this coin have an open position *before* the current poll cycle? */
  hadPositionBefore(coin: string): boolean;
  /** Leverage recorded for that pre-cycle position, if any. */
  leverageBefore(coin: string): number | null;
  /** Does this coin have an open position *after* the current poll cycle
   * (i.e. in the freshly-fetched clearinghouseState)? */
  hasPositionAfter(coin: string): boolean;
  /** Leverage in that freshly-fetched position, if any. */
  leverageAfter(coin: string): number | null;
}

export interface ActionDraft {
  coin: string;
  kind: ActionKind;
  side: Side;
  notionalUsd: string;
  avgPx: string;
  leverage: string | null;
  fillIds: bigint[];
  ts: Date;
}

/** JS numbers loses precision above this — Hyperliquid's `tid` is JSON
 * `number`, not a string, so this ceiling is a platform limitation, not a
 * bug here. See `watcher.service.ts` `toFillTid` for the guarded cast. */
export const MAX_SAFE_TID = Number.MAX_SAFE_INTEGER;

function toFillTid(fill: HlUserFill): bigint {
  if (fill.tid > MAX_SAFE_TID) {
    logger.warn(
      `Fill tid ${fill.tid} exceeds Number.MAX_SAFE_INTEGER — precision may already be lost by the time this process received it as JSON (Hyperliquid returns tid as a JSON number, not a string).`,
    );
  }
  return BigInt(fill.tid);
}

interface DirRun {
  category: DirCategory;
  side: Side;
  fills: HlUserFill[];
}

/** Merges a time-ordered, single-coin fill sequence into contiguous
 * same-`dir` runs (PRD §4.2 W3: "同地址、同幣、同方向的 fills ... 合併為一個
 * action"). Spot and unrecognized dirs are dropped before this is called. */
function toRuns(fills: HlUserFill[]): DirRun[] {
  const runs: DirRun[] = [];
  for (const fill of fills) {
    const info = PERPS_DIR[fill.dir];
    if (!info) continue; // filtered out by caller already; defensive no-op
    const last = runs[runs.length - 1];
    if (last && last.category === info.category && last.side === info.side) {
      last.fills.push(fill);
    } else {
      runs.push({ category: info.category, side: info.side, fills: [fill] });
    }
  }
  return runs;
}

function summarizeRun(fills: HlUserFill[]): { notionalUsd: number; avgPx: number; sz: number } {
  let notionalUsd = 0;
  let sz = 0;
  for (const fill of fills) {
    const px = Number(fill.px);
    const s = Number(fill.sz);
    notionalUsd += px * s;
    sz += s;
  }
  return { notionalUsd, avgPx: sz === 0 ? 0 : notionalUsd / sz, sz };
}

/**
 * Classifies one address's newly-fetched, perps-only, time-ordered fills
 * into `actions` rows (W3, adapted for polling — see `watcher.service.ts`
 * for how the batch is assembled). Fills for multiple coins may be
 * interleaved in `fills`; grouping happens per-coin, in time order, using
 * the state-machine below to distinguish open/add and close/reduce (`dir`
 * alone conflates these — "Open Long" fires for both a fresh open and
 * scaling into an existing long; disambiguating needs before/after
 * position state, not just the fill stream).
 *
 * Unrecognized `dir` values are logged and skipped (never guessed at) per
 * the task's explicit instruction — a schema change on Hyperliquid's side
 * must fail loud, not silently mis-classify.
 */
export function classifyFillsIntoActions(
  fills: HlUserFill[],
  state: PositionStateLookup,
): ActionDraft[] {
  const byCoin = new Map<string, HlUserFill[]>();
  for (const fill of fills) {
    if (isOutOfScopeSpotFill(fill)) continue;
    if (!PERPS_DIR[fill.dir]) {
      logger.error(
        `Unrecognized Hyperliquid fill dir "${fill.dir}" (coin=${fill.coin}, tid=${fill.tid}) — skipping this fill rather than guessing its action kind.`,
      );
      continue;
    }
    const list = byCoin.get(fill.coin) ?? [];
    list.push(fill);
    byCoin.set(fill.coin, list);
  }

  const drafts: ActionDraft[] = [];

  for (const [coin, coinFills] of byCoin) {
    const sorted = [...coinFills].sort((a, b) => a.time - b.time);
    const runs = toRuns(sorted);
    let currentlyHasPosition = state.hadPositionBefore(coin);

    runs.forEach((run, i) => {
      const isLast = i === runs.length - 1;
      let kind: ActionKind;

      if (run.category === "open") {
        kind = currentlyHasPosition ? "add" : "open";
        currentlyHasPosition = true;
      } else if (run.category === "close") {
        if (isLast) {
          const stillOpen = state.hasPositionAfter(coin);
          kind = stillOpen ? "reduce" : "close";
          currentlyHasPosition = stillOpen;
        } else {
          // A run after this one exists (open/flip) — the position must
          // have hit flat for that to make sense.
          kind = "close";
          currentlyHasPosition = false;
        }
      } else {
        kind = "flip";
        currentlyHasPosition = true;
      }

      const { notionalUsd, avgPx } = summarizeRun(run.fills);
      const leverage = currentlyHasPosition
        ? state.leverageAfter(coin)
        : state.leverageBefore(coin);
      const lastFill = run.fills[run.fills.length - 1];

      drafts.push({
        coin,
        kind,
        side: run.side,
        notionalUsd: notionalUsd.toString(),
        avgPx: avgPx.toString(),
        leverage: leverage === null ? null : leverage.toString(),
        fillIds: run.fills.map(toFillTid),
        ts: new Date(lastFill.time),
      });
    });
  }

  return drafts;
}
