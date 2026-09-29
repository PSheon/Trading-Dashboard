import type { HlClearinghouseStateResponse, HlUserFill, HlWsTrade } from "../src/hyperliquid/types.js";
import { fromScaled, toScaled } from "../src/watcher/action-classifier.js";
import { dexOf } from "../src/watcher/position-book.js";

/**
 * A fake exchange for one address: orders become real fills (with the
 * startPosition chain Hyperliquid would give them) and the matching `trades`
 * feed messages, and `stateAt` answers `clearinghouseState` as of any time.
 */
export class FakeExchange {
  readonly fills: HlUserFill[] = [];
  private nextTid = 1_000;

  constructor(
    readonly address: string,
    readonly leverage = 7,
  ) {}

  position(coin: string, upTo = Infinity): bigint {
    let p = 0n;
    for (const f of this.fills) {
      if (f.coin === coin && f.time <= upTo) p += (f.side === "B" ? 1n : -1n) * toScaled(f.sz);
    }
    return p;
  }

  /** One order: `sizes` fill in this sequence at `time` (same millisecond,
   * like one taker order crossing several levels). */
  order(
    coin: string,
    side: "B" | "A",
    sizes: string[],
    time: number,
    px = "100",
    extra: Partial<HlUserFill> = {},
  ): { fills: HlUserFill[]; trades: HlWsTrade[] } {
    const fills: HlUserFill[] = [];
    const trades: HlWsTrade[] = [];
    for (const sz of sizes) {
      const tid = this.nextTid++ * 7919; // not in execution order, like the real thing
      const fill: HlUserFill = {
        coin,
        px,
        sz,
        side,
        time,
        startPosition: fromScaled(this.position(coin)),
        dir: "Open Long",
        closedPnl: "0",
        hash: `0x${tid}`,
        oid: 1,
        crossed: true,
        fee: "0.1",
        tid,
        ...extra,
      };
      this.fills.push(fill);
      fills.push(fill);
      trades.push({
        coin,
        side,
        px,
        sz,
        time,
        hash: fill.hash,
        tid,
        users: side === "B" ? [this.address, "0xother"] : ["0xother", this.address],
      });
    }
    return { fills, trades };
  }

  stateAt(dex: string | undefined, time: number): HlClearinghouseStateResponse {
    const coins = new Set(this.fills.filter((f) => dexOf(f.coin) === (dex ?? "")).map((f) => f.coin));
    const summary = { accountValue: "1000", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" };
    return {
      assetPositions: [...coins]
        .map((coin) => ({ coin, szi: this.position(coin, time) }))
        .filter((p) => p.szi !== 0n)
        .map(({ coin, szi }) => ({
          type: "oneWay",
          position: {
            coin,
            szi: fromScaled(szi),
            leverage: { type: "cross", value: this.leverage },
            marginUsed: "0",
            unrealizedPnl: "0",
          },
        })),
      marginSummary: summary,
      crossMarginSummary: summary,
      withdrawable: "0",
      time,
    };
  }
}
