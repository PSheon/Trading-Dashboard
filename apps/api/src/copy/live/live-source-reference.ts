import { Dec } from '../../common/decimal/dec.js';
import type { CopyMarketService } from '../copy-market.service.js';
import { LiveBoundaryError, address } from './wallet-authorization.js';

/** Mainnet observations for a testnet copy of a mainnet leader: the coin's
 * mainnet mid (the deviation check) and the leader's whole-account value
 * (ratio sizing's denominator, the same figure paper copies use). */
export interface LiveSourceReference {
  readonly midPrice: string;
  readonly midObservedAt: number;
  readonly leaderEquity: string | null;
  readonly leaderEquityObservedAt: number | null;
}
export interface LiveSourceReferenceReader {
  read(leaderAddress: string, coin: string, includeEquity: boolean): Promise<LiveSourceReference>;
}

/** Reads through the paper copier's mainnet market service: its shared mids
 * (allMids, 3 s cache) and leader capital (60 s cache). Missing or failed
 * reads refuse; nothing is priced at zero. */
export class MainnetSourceReferenceReader implements LiveSourceReferenceReader {
  constructor(private readonly market: Pick<CopyMarketService, 'midPrices' | 'leaderEquity' | 'equityCache'>) {}
  async read(leader: string, coin: string, includeEquity: boolean): Promise<LiveSourceReference> {
    const leaderAddress = address(leader);
    const mids = await this.market.midPrices([coin]);
    const mid = mids?.px.get(coin);
    if (!mids || !mid || !mid.isPositive) throw new LiveBoundaryError('live_source_reference_unavailable');
    let leaderEquity: string | null = null, leaderEquityObservedAt: number | null = null;
    if (includeEquity) {
      const equity = await this.market.leaderEquity(leaderAddress);
      const cached = this.market.equityCache.get(leaderAddress);
      if (equity.state !== 'known' || !cached) throw new LiveBoundaryError('live_source_reference_unavailable');
      leaderEquity = Dec.from(equity.value.toString()).toString();
      leaderEquityObservedAt = cached.at;
    }
    return { midPrice: mid.toString(), midObservedAt: mids.at.getTime(), leaderEquity, leaderEquityObservedAt };
  }
}
