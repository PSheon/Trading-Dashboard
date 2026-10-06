import { Injectable,Optional } from "@nestjs/common";
import { WALLET_NETWORKS, usdSendRequest, withdrawalUnits } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { reserveLive } from "../hyperliquid/hyperliquid-budget-wait.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import {HyperliquidGlobalTransport} from '../hyperliquid/hyperliquid-global-transport.js';
import {LiveBoundaryError} from './live/wallet-authorization.js';
import type { FundingRow } from "./copy-funding.repository.js";

@Injectable()
export class CopyFundingExchangeClient {
  constructor(private readonly budget: RequestBudgeterService,@Optional() private readonly global?:HyperliquidGlobalTransport) {if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))throw new LiveBoundaryError("funding_client_invalid");}
  acquire() { return reserveLive(this.budget, 1, { maxWaitMs: 10_000 }); }
  private async read(url: string, body: Record<string, unknown>, weight: number): Promise<unknown> {
    await reserveLive(this.budget, weight, { maxWaitMs: 10_000 });
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
  async send(rawOperation:FundingRow,signature:string,assertFreshProof?:()=>void):Promise<unknown>{
    const operation=Object.freeze(structuredClone(rawOperation));
    try{
      const request:RequestInit={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(usdSendRequest(WALLET_NETWORKS[operation.network],operation.destination,operation.amount,operation.nonce,signature)),redirect:'error',signal:AbortSignal.timeout(20000)};
      if(this.global&&typeof assertFreshProof!=='function')throw new Error();
      const permit=this.global?await this.global.currentQuota().acquireRest(1,Date.now()+5000):undefined;
      const dispatch=()=>{const result:unknown=assertFreshProof?.();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error();}permit?.assertFresh();request.signal?.throwIfAborted();return fetch(WALLET_NETWORKS[operation.network].exchangeUrl,request);};
      const response=await (permit?permit.dispatch(dispatch):dispatch());if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error();}return await readInfoJson(response,'copy funding',64*1024);
    }catch{throw new LiveBoundaryError('funding_submission_unknown');}
  }
  txDetails(network: FundingRow["network"], hash: string) {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid funding evidence");
    const url = network === "mainnet" ? "https://rpc.hyperliquid.xyz/explorer" : "https://rpc.hyperliquid-testnet.xyz/explorer";
    return this.read(url, { type: "txDetails", hash }, 40);
  }
}
