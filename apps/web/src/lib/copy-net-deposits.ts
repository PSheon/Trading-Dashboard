import type { FundsFlowView } from "@/lib/funds";

/** The parts of a real copy its net deposits are read for. */
export interface NetDepositsCopy { strategyId: number; accountAddress: string | null; createdAt: string }

/** A copy funding still on its way (not yet accepted or refused): its amount is not settled. */
const UNSETTLED = new Set(["prepared", "unknown"]);
const COUNTED = new Set(["accepted", "credited"]);

/** Whether a copy funding row moved money back to the main wallet (a
 * withdrawal or the return after a stop) rather than into the copy: the
 * ledger's counterparty is the destination, which for a deposit is the
 * copy's own account. */
export function isCopyReturn(flow: Pick<FundsFlowView, "kind" | "counterparty">, accountAddress: string | null | undefined, owner: string | null | undefined): boolean | null {
  if (flow.kind !== "copy_funding") return null;
  const to = flow.counterparty?.toLowerCase() ?? null;
  if (to && accountAddress && to === accountAddress.toLowerCase()) return false;
  if (to && owner && to === owner.toLowerCase()) return true;
  return null;
}

/**
 * A real copy's net deposits from Orbie's money-flow ledger (GET
 * /me/funds/history): every deposit into the copy's account (the budget and
 * each 加碼) less every withdrawal and return to the main wallet. PnL is
 * equity less this, so taking money out is never counted as a loss.
 *
 * Null (the page shows "—") whenever it is not known for sure: the ledger
 * has not been read back to the copy's start, it has no deposit for the
 * copy, a transfer is still on its way, or a row cannot be placed.
 */
export function liveNetDeposits(flows: readonly FundsFlowView[], complete: boolean, copy: NetDepositsCopy, owner: string | null | undefined): number | null {
  if (!copy.accountAddress) return null;
  if (!complete) {
    // Older pages exist: the ledger is known only back to its oldest row.
    const oldest = flows.reduce((min, f) => Math.min(min, Date.parse(String(f.time))), Number.POSITIVE_INFINITY);
    if (!(oldest <= Date.parse(copy.createdAt))) return null;
  }
  const rows = flows.filter((f) => f.kind === "copy_funding" && f.strategyId === copy.strategyId);
  let net = 0, deposited = false;
  for (const row of rows) {
    if (row.status && UNSETTLED.has(row.status)) return null;
    if (!row.status || !COUNTED.has(row.status)) continue;
    const back = isCopyReturn(row, copy.accountAddress, owner);
    if (back === null) return null;
    const amount = Math.abs(row.amount);
    if (back) net -= amount;
    else { net += amount; deposited = true; }
  }
  return deposited ? Math.round(net * 1e6) / 1e6 : null;
}

/** PnL and ROI of a real copy: equity less its net deposits; null while either is unknown. */
export function livePnl(equity: number | null, netDeposits: number | null): { pnl: number | null; roi: number | null } {
  if (equity === null || netDeposits === null || !Number.isFinite(equity)) return { pnl: null, roi: null };
  const pnl = equity - netDeposits;
  return { pnl, roi: netDeposits > 0 ? pnl / netDeposits : null };
}
