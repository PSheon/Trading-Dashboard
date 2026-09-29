import { Logger } from "@nestjs/common";
import type { ActionKind } from "@trading-dashboard/shared/contracts";

import type { HlUserFill } from "../hyperliquid/types.js";

const logger = new Logger("ActionClassifier");

/**
 * Fills → `actions` (PRD §4.2 W3).
 *
 * Every Hyperliquid fill carries `startPosition`, the signed position size
 * right before it. That alone decides the action kind exactly — no need to
 * compare polled position snapshots, which went wrong after every restart
 * (empty memory made every add look like an open) and when a round trip
 * fitted between two polls.
 *
 * Grouping: fills of the same coin, same side (B/A) and same liquidation
 * status, each within `GROUP_GAP_MS` of the previous one, form one action.
 * One market order that crosses eight resting orders is eight fills and one
 * action. The group's kind comes from the position before its first fill
 * and after its last fill:
 *
 *   before = 0, after ≠ 0            → open
 *   before ≠ 0, after = 0            → close
 *   signs differ, both ≠ 0           → flip
 *   same sign, |after| > |before|    → add
 *   same sign, |after| < |before|    → reduce
 *   any fill liquidates this address → liquidation
 *
 * Side is the position's side: after the action for open/add/flip, before
 * it for reduce/close/liquidation.
 */
export const GROUP_GAP_MS = 1000;

/** §11 "只看 perps，不看 spot". Spot coins are "@107" or "PURR/USDC"; perps
 * are "BTC" or, on a HIP-3 dex, "xyz:TSLA". */
const SPOT_DIRS = new Set(["Buy", "Sell", "Spot Dust Conversion"]);

export function isOutOfScopeSpotFill(fill: HlUserFill): boolean {
  return SPOT_DIRS.has(fill.dir) || fill.coin.includes("/") || fill.coin.startsWith("@");
}

type Side = "long" | "short";

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

/** Positions are compared exactly: decimal strings scaled to integers. */
const SCALE_DIGITS = 12;

export function toScaled(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const frac = (fracPart + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  const scaled = BigInt(intPart || "0") * 10n ** BigInt(SCALE_DIGITS) + BigInt(frac || "0");
  return negative ? -scaled : scaled;
}

/** Inverse of `toScaled`: a plain decimal string, no trailing zeros. */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE_DIGITS + 1, "0");
  const intPart = digits.slice(0, -SCALE_DIGITS);
  const fracPart = digits.slice(-SCALE_DIGITS).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

/** Signed size of a fill from its owner's side: + for a buy. */
export function signedSize(fill: Pick<HlUserFill, "side" | "sz">): bigint {
  const sz = toScaled(fill.sz);
  return fill.side === "B" ? sz : -sz;
}

const sign = (v: bigint): -1 | 0 | 1 => (v > 0n ? 1 : v < 0n ? -1 : 0);
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

export function kindFor(before: bigint, after: bigint): { kind: ActionKind; side: Side } | null {
  const b = sign(before);
  const a = sign(after);
  if (b === 0 && a === 0) return null;
  if (b === 0) return { kind: "open", side: a > 0 ? "long" : "short" };
  if (a === 0) return { kind: "close", side: b > 0 ? "long" : "short" };
  if (a !== b) return { kind: "flip", side: a > 0 ? "long" : "short" };
  return abs(after) > abs(before)
    ? { kind: "add", side: a > 0 ? "long" : "short" }
    : { kind: "reduce", side: a > 0 ? "long" : "short" };
}

/** Hyperliquid returns `tid` as a JSON number. Values seen so far are
 * ~1e15, under 2^53; past that, precision is already gone on arrival. */
function toFillTid(fill: HlUserFill): bigint {
  if (fill.tid > Number.MAX_SAFE_INTEGER) {
    logger.warn(`Fill tid ${fill.tid} exceeds Number.MAX_SAFE_INTEGER; precision may be lost`);
  }
  return BigInt(fill.tid);
}

export function liquidates(fill: HlUserFill, address: string): boolean {
  return fill.liquidation?.liquidatedUser?.toLowerCase() === address.toLowerCase();
}

/**
 * Sorts one coin's fills by time, and fills sharing a millisecond into the
 * order they executed in. `tid` is NOT that order (checked live 2026-09-29:
 * same-millisecond fills sorted by tid broke the startPosition chain in about
 * half the cases); the info API and the trade feed both list fills in
 * execution order, and within a millisecond each fill starts where the
 * previous one ended. So a same-millisecond run is chained by startPosition
 * when that is unambiguous (fills read back from the database come in no
 * particular order), and otherwise keeps the order it was given in.
 */
export function executionOrder(fills: HlUserFill[]): HlUserFill[] {
  const sorted = [...fills].sort((x, y) => x.time - y.time);
  const out: HlUserFill[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].time === sorted[i].time) j++;
    const run = sorted.slice(i, j);
    out.push(...(run.length > 1 ? (chainByPosition(run) ?? run) : run));
    i = j;
  }
  return out;
}

function chainByPosition(run: HlUserFill[]): HlUserFill[] | null {
  if (run.some((f) => f.startPosition === undefined)) return null;
  const start = run.map((f) => toScaled(f.startPosition!));
  const end = run.map((f, k) => start[k] + signedSize(f));
  const indexes = run.map((_, k) => k);
  const heads = indexes.filter((k) => !end.some((e, m) => m !== k && e === start[k]));
  if (heads.length !== 1) return null;
  const order = [heads[0]];
  const used = new Set(order);
  while (order.length < run.length) {
    const last = order[order.length - 1];
    const next = indexes.filter((k) => !used.has(k) && start[k] === end[last]);
    if (next.length !== 1) return null;
    used.add(next[0]);
    order.push(next[0]);
  }
  return order.map((k) => run[k]);
}

interface Group {
  coin: string;
  side: "A" | "B";
  liquidation: boolean;
  fills: HlUserFill[];
}

function groupFills(address: string, fills: HlUserFill[]): Group[] {
  const byCoin = new Map<string, HlUserFill[]>();
  for (const fill of fills) {
    const list = byCoin.get(fill.coin) ?? [];
    list.push(fill);
    byCoin.set(fill.coin, list);
  }
  const groups: Group[] = [];
  for (const [coin, coinFills] of byCoin) {
    let current: Group | undefined;
    for (const fill of executionOrder(coinFills)) {
      const liquidation = liquidates(fill, address);
      const last = current?.fills[current.fills.length - 1];
      if (
        current &&
        last &&
        current.side === fill.side &&
        current.liquidation === liquidation &&
        fill.time - last.time <= GROUP_GAP_MS
      ) {
        current.fills.push(fill);
      } else {
        current = { coin, side: fill.side, liquidation, fills: [fill] };
        groups.push(current);
      }
    }
  }
  return groups.sort(
    (x, y) => x.fills[x.fills.length - 1].time - y.fills[y.fills.length - 1].time,
  );
}

/**
 * Classifies one address's newly stored perp fills into action drafts.
 * Spot fills are ignored. A group whose fills lack `startPosition` can't be
 * classified; it is logged and skipped (the fills themselves are already
 * stored).
 */
export function classifyFills(
  address: string,
  fills: HlUserFill[],
  leverageFor: (coin: string) => number | null = () => null,
): ActionDraft[] {
  const drafts: ActionDraft[] = [];
  for (const group of groupFills(address, fills.filter((f) => !isOutOfScopeSpotFill(f)))) {
    const first = group.fills[0];
    if (group.fills.some((f) => f.startPosition === undefined)) {
      logger.error(
        `Fill without startPosition (address=${address}, coin=${group.coin}, tid=${first.tid}); action skipped`,
      );
      continue;
    }
    const before = toScaled(first.startPosition!);
    let after = before;
    let notional = 0;
    let size = 0;
    for (const fill of group.fills) {
      after += signedSize(fill);
      notional += Number(fill.px) * Number(fill.sz);
      size += Number(fill.sz);
    }

    const shape = kindFor(before, after);
    if (!shape) continue;
    const kind: ActionKind = group.liquidation ? "liquidation" : shape.kind;
    const side: Side = group.liquidation ? (sign(before) > 0 ? "long" : "short") : shape.side;
    const leverage = sign(after) === 0 ? null : leverageFor(group.coin);
    const last = group.fills[group.fills.length - 1];

    drafts.push({
      coin: group.coin,
      kind,
      side,
      notionalUsd: notional.toString(),
      avgPx: (size === 0 ? 0 : notional / size).toString(),
      leverage: leverage === null ? null : leverage.toString(),
      fillIds: group.fills.map(toFillTid),
      ts: new Date(last.time),
    });
  }
  return drafts;
}
