import { Injectable,Optional } from "@nestjs/common";
import { WALLET_NETWORKS, usdSendRequest, withdrawalUnits } from "@trading-dashboard/shared/contracts";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import {HyperliquidGlobalTransport} from '../hyperliquid/hyperliquid-global-transport.js';
import {LiveBoundaryError} from './live/wallet-authorization.js';
import type { FundingRow } from "./copy-funding.repository.js";

@Injectable()
export class CopyFundingExchangeClient {
  constructor(private readonly budget: RequestBudgeterService,@Optional() private readonly global?:HyperliquidGlobalTransport) {if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))throw new LiveBoundaryError("funding_client_invalid");}
  acquire() { return this.budget.acquire(1, "live", 0, { signal: AbortSignal.timeout(10_000) }); }
  private async read(url: string, body: Record<string, unknown>, weight: number): Promise<unknown> {
    await this.budget.acquire(weight, "live", 0, { signal: AbortSignal.timeout(10_000) });
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
