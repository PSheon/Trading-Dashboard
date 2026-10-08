import { sql } from 'drizzle-orm';
import { copyExecutionAccounts } from '@trading-dashboard/shared/database';

/** Read scheduling only. Financial recovery still uses its original operation
 * identity and proof; none of these hints grants authority or refreshes evidence. */
export const followerRecoveryAccount = sql`(${copyExecutionAccounts.network} = 'testnet' and (exists (select 1 from copy_live_mandates recovery_m
    where recovery_m.account_id = ${copyExecutionAccounts.id} and recovery_m.state = 'stopping'
      and recovery_m.user_id = ${copyExecutionAccounts.userId} and recovery_m.strategy_id = ${copyExecutionAccounts.strategyId}
      and recovery_m.network = ${copyExecutionAccounts.network} and recovery_m.account_address = ${copyExecutionAccounts.address}
      and recovery_m.owner_privy_user_id = ${copyExecutionAccounts.privyUserId})
  or exists (select 1 from copy_live_stop_operations recovery_s
    where recovery_s.account_id = ${copyExecutionAccounts.id} and recovery_s.state <> 'stopped'
      and recovery_s.user_id = ${copyExecutionAccounts.userId} and recovery_s.strategy_id = ${copyExecutionAccounts.strategyId}
      and recovery_s.network = ${copyExecutionAccounts.network} and recovery_s.account_address = ${copyExecutionAccounts.address}
      and recovery_s.owner_privy_user_id = ${copyExecutionAccounts.privyUserId})
  or exists (select 1 from copy_funding_operations recovery_f
    where recovery_f.account_id = ${copyExecutionAccounts.id} and recovery_f.status in ('unknown','accepted')
      and recovery_f.user_id = ${copyExecutionAccounts.userId} and recovery_f.strategy_id = ${copyExecutionAccounts.strategyId}
      and recovery_f.network = ${copyExecutionAccounts.network}
      and ((recovery_f.direction = 'to_account' and recovery_f.destination = ${copyExecutionAccounts.address})
        or (recovery_f.direction = 'to_main' and recovery_f.address = ${copyExecutionAccounts.address})))))`;

/** All testnet accounts share the process bucket. A fresh pending/submitted
 * fill takes priority over ordinary background reads even of another account.
 * Use the ORIGINAL leader timestamp and database clock: a stuck dispatch cannot
 * perpetually renew its priority. Foreground runFor bypasses this scheduler. */
const foregroundRows = sql`from copy_live_dispatches priority_d
    inner join copy_live_mandates priority_m on priority_m.id = priority_d.mandate_id
    inner join copy_execution_accounts priority_a on priority_a.id = priority_d.account_id
    where priority_a.network = 'testnet' and priority_m.network = 'testnet'
      and priority_d.account_id = priority_m.account_id
      and priority_d.user_id = priority_m.user_id and priority_m.user_id = priority_a.user_id
      and priority_d.strategy_id = priority_m.strategy_id and priority_m.strategy_id = priority_a.strategy_id
      and priority_m.account_address = priority_a.address and priority_m.owner_privy_user_id = priority_a.privy_user_id
      and priority_m.state in ('active','paused') and priority_d.state in ('pending','submitted')
      and priority_d.leader_time <= clock_timestamp()
      and priority_d.leader_time > clock_timestamp() - interval '120 seconds'`;
export const followerFreshForeground = sql`exists (select 1 ${foregroundRows})`;
export const followerAccountFreshForeground = sql`exists (select 1 ${foregroundRows} and priority_a.id = ${copyExecutionAccounts.id})`;
export function followerForegroundReadEligible(allowRetainedFairness = false) {
  return sql`(${copyExecutionAccounts.network} <> 'testnet' or ${followerRecoveryAccount}
    or not ${followerFreshForeground}
    or (${allowRetainedFairness} and not ${followerAccountFreshForeground}))`;
}
