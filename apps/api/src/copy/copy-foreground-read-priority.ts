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
 * New orders use the ORIGINAL leader timestamp and database clock. A terminal
 * original execution with an attempted, unreleased reservation retains proof
 * priority independently of source age: expiry does not settle a liability.
 * Other accounts retain their independent five-minute fairness admission.
 * Foreground runFor bypasses this ordinary reporting scheduler. */
const foregroundRows = sql`from copy_live_dispatches priority_d
    inner join copy_live_mandates priority_m on priority_m.id = priority_d.mandate_id
    inner join copy_execution_accounts priority_a on priority_a.id = priority_d.account_id
    where priority_a.network = 'testnet' and priority_m.network = 'testnet'
      and priority_d.account_id = priority_m.account_id
      and priority_d.user_id = priority_m.user_id and priority_m.user_id = priority_a.user_id
      and priority_d.strategy_id = priority_m.strategy_id and priority_m.strategy_id = priority_a.strategy_id
      and priority_m.account_address = priority_a.address and priority_m.owner_privy_user_id = priority_a.privy_user_id
      and priority_d.state in ('pending','submitted')
      and priority_d.leader_time <= clock_timestamp()
      and ((priority_m.state in ('active','paused') and priority_d.leader_time > clock_timestamp() - interval '120 seconds')
        or (priority_d.state = 'submitted' and exists (
          select 1 from copy_live_executions priority_j
          inner join copy_live_risk_reservations priority_r on priority_r.key = priority_j.key
          where priority_j.key = priority_d.execution_key
            and priority_j.key = priority_a.network || ':' || priority_a.address || ':' || priority_j.cloid
            and priority_j.network = priority_a.network and priority_j.user_id = priority_a.user_id
            and priority_j.strategy_id = priority_a.strategy_id and priority_j.account_address = priority_a.address
            and priority_j.state in ('filled','partial','cancelled','rejected')
            and priority_r.account_id = priority_a.id and priority_r.user_id = priority_a.user_id
            and priority_r.strategy_id = priority_a.strategy_id and priority_r.network = priority_a.network
            and priority_r.account_address = priority_a.address and priority_r.cloid = priority_j.cloid
            and priority_r.attempted_at is not null and priority_r.state <> 'released'
        )))`;
export const followerFreshForeground = sql`exists (select 1 ${foregroundRows})`;
export const followerAccountFreshForeground = sql`exists (select 1 ${foregroundRows} and priority_a.id = ${copyExecutionAccounts.id})`;
export function followerForegroundReadEligible(allowRetainedFairness = false) {
  return sql`(${copyExecutionAccounts.network} <> 'testnet' or ${followerRecoveryAccount}
    or not ${followerFreshForeground}
    or (${allowRetainedFairness} and not ${followerAccountFreshForeground}))`;
}
