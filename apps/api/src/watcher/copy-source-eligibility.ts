import { sql } from 'drizzle-orm';
import { copyLiveStrategyConfigs, copyStrategies } from '@trading-dashboard/shared/database';
import { ACTUAL_STRATEGY_MODE, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';

/** The mainnet watcher prioritizes paper sources and actual copies executed
 * by this deployment. Other execution networks remain historical records;
 * they must not take live read priority or schedule copy catch-ups here. */
export const copySourceEligibility = (network: HyperliquidNetwork) => sql`(
  ${copyStrategies.mode} = 'paper' or (
    ${copyStrategies.mode} = ${ACTUAL_STRATEGY_MODE}
    and ${copyStrategies.network} = ${network}
    and exists (select 1 from ${copyLiveStrategyConfigs} c
      where c.strategy_id = ${copyStrategies.id} and c.source_network = 'mainnet')
  )
)`;
