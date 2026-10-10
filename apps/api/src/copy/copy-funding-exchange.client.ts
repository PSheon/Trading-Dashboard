import { createHash } from 'node:crypto';
import { Injectable,Optional } from "@nestjs/common";
import { WALLET_NETWORKS, usdSendRequest, withdrawalUnits } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { reserveLive } from "../hyperliquid/hyperliquid-budget-wait.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import {HyperliquidGlobalTransport} from '../hyperliquid/hyperliquid-global-transport.js';
import {LiveBoundaryError} from './live/wallet-authorization.js';
import type { FundingRow } from "./copy-funding.repository.js";

/** Process-local evidence only. Never infer dispatch from a serialized code,
 * a balance, a quota charge or a historical operation. The exact private error
 * object is bound to the exact attempt captured by this transport invocation. */
const notDispatched = new WeakMap<object, string>();
const attemptDigest = (row: FundingRow) => createHash('sha256').update(JSON.stringify(
  Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
)).digest('hex');
export function isFundingNotDispatched(error: unknown, attempt: FundingRow): boolean {
  return error instanceof LiveBoundaryError && error.code === 'funding_not_dispatched' &&
    notDispatched.get(error) === attemptDigest(attempt);
}
/** One-use original evidence: a failed CAS must never turn into authority to
 * reset a later attempt, even if a test/frozen clock repeats its timestamps. */
export function consumeFundingNotDispatched(error: unknown, attempt: FundingRow): boolean {
  if (!isFundingNotDispatched(error, attempt)) return false;
  notDispatched.delete(error as object);
  return true;
}

@Injectable()
export class CopyFundingExchangeClient {
  constructor(private readonly budget: RequestBudgeterService,@Optional() private readonly global?:HyperliquidGlobalTransport) {if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))throw new LiveBoundaryError("funding_client_invalid");}
  acquire() { return reserveLive(this.budget, 1, { maxWaitMs: 10_000 }); }
  private async read(url: string, body: Record<string, unknown>, weight: number, receipt = false): Promise<unknown> {
    // A durable receipt lookup has no quote/proof clock yet. Keep its place
    // behind admitted order evidence for one bucket refill (at most 120 s),
    // rather than repeatedly abandoning the queue on a 10 s estimate. HTTP
    // remains bounded to 10 s AFTER admission; balances and sends keep their
    // original short wait. This grants no submission or credit authority.
    const maxWaitMs = receipt ? Math.min(120_000, Math.max(10_000, this.budget.refillMs())) : 10_000;
    await reserveLive(this.budget, weight, { maxWaitMs });
    const fetcher=this.global?(url.endsWith("/explorer")?this.global.fetchExplorer:this.global.fetchInfo):fetch;
    const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("Funding evidence unavailable"); }
    return readInfoJson(response, "copy funding evidence", 1024 * 1024);
  }
  async available(operation: FundingRow): Promise<boolean> {
    const value = await this.read(WALLET_NETWORKS[operation.network].infoUrl, { type: "clearinghouseState", user: operation.address }, 2);
    if (!value || typeof value !== "object" || !("withdrawable" in value) || typeof value.withdrawable !== "string") throw new Error("Funding balance unavailable");
    return withdrawalUnits(value.withdrawable) >= withdrawalUnits(operation.amount);
  }
  /** The account's transferable perp USDC (clearinghouseState.withdrawable). */
  async withdrawable(network: FundingRow["network"], address: string): Promise<string> {
    const value = await this.read(WALLET_NETWORKS[network].infoUrl, { type: "clearinghouseState", user: address }, 2);
    if (!value || typeof value !== "object" || !("withdrawable" in value) || typeof value.withdrawable !== "string" || !/^\d+(?:\.\d+)?$/.test(value.withdrawable)) throw new Error("Funding balance unavailable");
    return value.withdrawable;
  }
  /**
   * Whether a copy account holds anything (account deletion): its perp
   * account value, open positions, resting orders and spot balances. Below a
   * cent counts as empty (rounding dust can't be returned). Throws when the
   * exchange can't be read: an unknown balance is never treated as empty.
   */
  async holdings(network: FundingRow["network"], address: string): Promise<{ empty: boolean; accountValue: string; positions: number; openOrders: number; spotBalances: number }> {
    const url = WALLET_NETWORKS[network].infoUrl;
    const perp = await this.read(url, { type: "clearinghouseState", user: address }, 2);
    const orders = await this.read(url, { type: "openOrders", user: address }, 20);
    const spot = await this.read(url, { type: "spotClearinghouseState", user: address }, 2);
    const decimal = (value: unknown) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
    if (!perp || typeof perp !== "object" || !("marginSummary" in perp) || !perp.marginSummary || typeof perp.marginSummary !== "object" ||
      !("accountValue" in perp.marginSummary) || !decimal(perp.marginSummary.accountValue) || !("assetPositions" in perp) || !Array.isArray(perp.assetPositions) ||
      !Array.isArray(orders) || !spot || typeof spot !== "object" || !("balances" in spot) || !Array.isArray(spot.balances)) throw new Error("Account holdings unavailable");
    const accountValue = perp.marginSummary.accountValue as string;
    const positions = perp.assetPositions.filter((p: unknown) => {
      const size = p && typeof p === "object" && "position" in p && p.position && typeof p.position === "object" && "szi" in p.position ? p.position.szi : null;
      if (!decimal(size)) throw new Error("Account holdings unavailable");
      return Number(size) !== 0;
    }).length;
    const spotBalances = spot.balances.filter((b: unknown) => {
      const total = b && typeof b === "object" && "total" in b ? b.total : null;
      if (!decimal(total)) throw new Error("Account holdings unavailable");
      return Number(total) >= 0.01;
    }).length;
    const empty = Math.abs(Number(accountValue)) < 0.01 && positions === 0 && orders.length === 0 && spotBalances === 0;
    return { empty, accountValue, positions, openOrders: orders.length, spotBalances };
  }
  /** Sends an exact user-signed action (approveBuilderFee) from the account. */
  async sendAction(network: FundingRow["network"], body: unknown, assertFreshProof: () => void): Promise<unknown> {
    try {
      const request: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) };
      const permit = this.global ? await this.global.currentQuota().acquireRest(1, Date.now() + 5000) : undefined;
      const dispatch = () => { const result: unknown = assertFreshProof(); if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new Error(); } permit?.assertFresh(); return fetch(WALLET_NETWORKS[network].exchangeUrl, request); };
      const response = await (permit ? permit.dispatch(dispatch) : dispatch()); if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(); }
      return await readInfoJson(response, 'copy account action', 64 * 1024);
    } catch { throw new LiveBoundaryError('account_action_submission_unknown'); }
  }
  async maxBuilderFee(network: FundingRow["network"], user: string, builder: string): Promise<number> {
    const value = await this.read(WALLET_NETWORKS[network].infoUrl, { type: "maxBuilderFee", user, builder }, 20);
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Builder approval unavailable");
    return value as number;
  }
  /** `onDispatch` runs after every check (the caller's proof, then the
   * quota permit rechecked after it), right before the POST: a caller that
   * must tell "never sent" from "maybe sent" (the automatic return) marks
   * the send dispatched there, never in its proof. */
  async send(rawOperation:FundingRow,signature:string,assertFreshProof?:()=>void,onDispatch?:()=>void):Promise<unknown>{
    const operation=Object.freeze(structuredClone(rawOperation));
    let dispatched=false;
    try{
      const request:RequestInit={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(usdSendRequest(WALLET_NETWORKS[operation.network],operation.destination,operation.amount,operation.nonce,signature)),redirect:'error',signal:AbortSignal.timeout(20000)};
      if(this.global&&typeof assertFreshProof!=='function')throw new Error();
      const permit=this.global?await this.global.currentQuota().acquireRest(1,Date.now()+5000):undefined;
      const dispatch=()=>{const result:unknown=assertFreshProof?.();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error();}permit?.assertFresh();request.signal?.throwIfAborted();dispatched=true;onDispatch?.();return fetch(WALLET_NETWORKS[operation.network].exchangeUrl,request);};
      const response=await (permit?permit.dispatch(dispatch):dispatch());if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error();}return await readInfoJson(response,'copy funding',64*1024);
    }catch{
      if(dispatched)throw new LiveBoundaryError('funding_submission_unknown');
      const error=new LiveBoundaryError('funding_not_dispatched');
      notDispatched.set(error,attemptDigest(operation));
      throw error;
    }
  }
  txDetails(network: FundingRow["network"], hash: string) {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid funding evidence");
    const url = network === "mainnet" ? "https://rpc.hyperliquid.xyz/explorer" : "https://rpc.hyperliquid-testnet.xyz/explorer";
    return this.read(url, { type: "txDetails", hash }, 40, true);
  }
}
