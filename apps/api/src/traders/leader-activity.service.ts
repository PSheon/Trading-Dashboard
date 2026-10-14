import { Injectable, Optional } from '@nestjs/common';
import { LEADER_ACTIVITY_WINDOW_MS, leaderCopyActivity, measureLeaderActivity, type LeaderCopyActivity } from '@trading-dashboard/shared/contracts';

import { HyperliquidInfoClient, MAX_LIST_ITEMS } from '../hyperliquid/hyperliquid-info.client.js';
import { PAGE_RANK } from '../hyperliquid/request-budgeter.service.js';
import { TtlCache } from './ttl-cache.js';
import { COPY_ACTIVITY_TTL_MS } from '../config/constants/cache-ttls.js';


/**
 * Whether a live copy can keep up with a leader (`leader-activity.ts` in
 * shared): one `userFillsByTime` page of the last 24 h on the data host
 * (HYPERLIQUID_API_URL, mainnet), as page work on the background lane, never
 * ahead of live detection. Served to the copy panel (GET
 * /traders/:address/copy-activity) and checked again by a mainnet start.
 */
@Injectable()
export class LeaderActivityService {
  readonly cache = new TtlCache<LeaderCopyActivity>(COPY_ACTIVITY_TTL_MS);
  constructor(private readonly info: HyperliquidInfoClient, @Optional() private readonly now: () => number = Date.now) {}

  copyActivity(address: string): Promise<LeaderCopyActivity> {
    const key = address.toLowerCase();
    return this.cache.get(key, async () => {
      const now = this.now();
      const fills = await this.info.userFillsByTime(key, now - LEADER_ACTIVITY_WINDOW_MS, now, 'background', PAGE_RANK.fills);
      return leaderCopyActivity(measureLeaderActivity(fills, now, fills.length >= MAX_LIST_ITEMS), new Date(now));
    }, COPY_ACTIVITY_TTL_MS, PAGE_RANK.fills);
  }
}
