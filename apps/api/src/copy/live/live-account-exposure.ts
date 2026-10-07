import { sql, type SQLWrapper } from 'drizzle-orm';
import { ACTUAL_STRATEGY_MODE } from '@trading-dashboard/shared/contracts';

/** Shared by the budget estimate and original SQL authority. A pure paper
 * wallet placeholder has no actual exposure. Historical actual bindings and
 * unfinished money/mandates/liabilities remain conservatively observable. */
export function liveAccountExposureSql(accountId: SQLWrapper, mode: SQLWrapper, status: SQLWrapper) {
  return sql`(
    (${mode} = ${ACTUAL_STRATEGY_MODE}
      or exists (select 1 from copy_funding_operations f where f.account_id=${accountId})
      or exists (select 1 from copy_live_mandates m where m.account_id=${accountId})
      or exists (select 1 from copy_live_risk_reservations r where r.account_id=${accountId}))
    and (${status}<>'stopped'
      or exists (select 1 from copy_funding_operations f where f.account_id=${accountId} and f.status in ('prepared','unknown','accepted'))
      or exists (select 1 from copy_live_mandates m where m.account_id=${accountId} and m.state in ('active','paused','stopping'))
      or exists (select 1 from copy_live_risk_reservations r where r.account_id=${accountId} and r.state<>'released'))
  )`;
}
