import {HyperliquidGlobalTransport} from '../hyperliquid/hyperliquid-global-transport.js';
import {boundedLiveRead} from './live/live-market-resolver.js';
import { LIVE_RESERVE_WAIT_MS, sharedCapacityWait } from "../hyperliquid/hyperliquid-budget-wait.js";
import { WALLET_NETWORKS, splitSignature } from "@trading-dashboard/shared/contracts";
import { z } from "zod";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import { agentApprovalTypedData, type AgentConsentIntent } from "./copy-agent-consent.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";
import { Logger } from "@nestjs/common";
import { safeErrorText } from "../runtime/safe-error-text.js";

export const AGENT_APPROVAL_CLIENT = Symbol("AGENT_APPROVAL_CLIENT");
/** Provider weight of one agent observation: userRole 60 + extraAgents 20. */
export const AGENT_OBSERVE_WEIGHT = 80;
export interface AgentApprovalClient {
  readonly available: boolean;
  acquire(): Promise<unknown>;
  /** Takes weight before a clock starts (HyperliquidBudgetWait when busy). Optional for doubles. */
  reserve?(weight: number): Promise<unknown>;
  send(intent: AgentConsentIntent, signature: string,assertFreshProof?:()=>void): Promise<unknown>;
  /** `prepaid`: the caller reserved OBSERVE_WEIGHT before its own clock. */
  observe(intent: AgentConsentIntent, options?: { prepaid?: boolean }): Promise<{ checkedAt: number; validUntil: number } | null>;
}
const agents = z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(256),
  validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() })).max(100);

/** Sends one exact master approval (signed by the copy account in the
 * owner's browser) and observes it; signs nothing itself. */
export class PrivyAgentApprovalClient implements AgentApprovalClient {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(config: { appId?: string; appSecret?: string }, private readonly budget: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now,private readonly global?:HyperliquidGlobalTransport) {
    if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))throw new LiveBoundaryError("agent_approval_client_invalid");
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  get available() { return this.credentials !== null; }
  acquire() { return this.budget(1); }
  reserve(weight: number) { return this.budget(weight); }
  async send(rawIntent:AgentConsentIntent,signature:string,assertFreshProof?:()=>void):Promise<unknown>{
    const intent=Object.freeze(structuredClone(rawIntent)),data=agentApprovalTypedData(intent);
    if(this.now()>=intent.consentExpiresAt)throw new LiveBoundaryError('agent_consent_expired');
    let dispatched=false;
    try{
      const network=WALLET_NETWORKS[intent.network];
      const request:RequestInit={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:{type:'approveAgent',signatureChainId:network.signatureChainId,...data.message},nonce:intent.nonce,signature:splitSignature(signature)}),redirect:'error',signal:AbortSignal.timeout(10000)};
      if(this.global&&typeof assertFreshProof!=='function')throw new Error();
      const permit=this.global?await this.global.currentQuota().acquireRest(1,Math.min(this.now()+5000,intent.consentExpiresAt)):undefined;
      const dispatch=()=>{
        const result:unknown=assertFreshProof?.();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error();}
        permit?.assertFresh();if(this.now()<intent.nonce||this.now()>=intent.consentExpiresAt)throw new Error();
        dispatched=true;return this.fetcher(network.exchangeUrl,request);
      };
      const response=await (permit?permit.dispatch(dispatch):dispatch());
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error();}return await readInfoJson(response,'agent approval submission',64*1024);
    }catch(error){
      // Refused before the POST reached the transport (the meter's permit, a
      // stale proof, the clock): nothing left this process. Either way, why.
      const code=dispatched?'agent_approval_submission_unknown':'agent_approval_not_dispatched';
      new Logger('PrivyAgentApprovalClient').warn(`agent approval ${code}: ${safeErrorText(error)}`);
      throw new LiveBoundaryError(code);
    }
  }
  /** Provider weight of one observation: userRole 60 + extraAgents 20. */
  static readonly OBSERVE_WEIGHT = AGENT_OBSERVE_WEIGHT;
  async observe(intent: AgentConsentIntent, options: { prepaid?: boolean } = {}): Promise<{ checkedAt: number; validUntil: number } | null> {
    const data = agentApprovalTypedData(intent);
    // Both reads are paid for before the 5 s clock starts: a budget wait
    // never ages the evidence (it did, and after the mode step drained the
    // bucket every observation timed out). A busy budget is a typed wait.
    if (!options.prepaid) await this.budget(PrivyAgentApprovalClient.OBSERVE_WEIGHT);
    let checkedAt = 0;
    try {
      // Both reads are one charge of the shared meter, sent together; the
      // clock starts as they go out (after any wait for room).
      const bodies = [{ type: "userRole", user: intent.accountAddress }, { type: "extraAgents", user: intent.accountAddress }] as const;
      const start = () => { checkedAt = this.now(); return AbortSignal.timeout(5_000); };
      const global = this.global;
      const responses = await boundedLiveRead(() => global
        ? global.fetchInfoBatch(WALLET_NETWORKS.testnet.infoUrl, bodies, { maxWaitMs: LIVE_RESERVE_WAIT_MS, onDispatch: start })
        : (() => { const signal = start(); return Promise.all(bodies.map(body => this.fetcher(WALLET_NETWORKS.testnet.infoUrl, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal }))); })(), LIVE_RESERVE_WAIT_MS + 5_000);
      const [role, listed] = await Promise.all(responses.map(async response => {
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
        return boundedLiveRead(() => readInfoJson(response, "agent approval evidence", 64 * 1024), () => Math.max(1, 5_000 - (this.now() - checkedAt)));
      }));
      // A strategy master must be a user account. Agents/vaults/subaccounts are
      // not interchangeable with an explicitly owned, funded master account.
      if (!role || typeof role !== "object" || !("role" in role) || role.role !== "user") throw new Error();
      const list = agents.parse(listed);
      const matches = list.filter(a => a.address.toLowerCase() === data.message.agentAddress);
      if (this.now() < checkedAt || this.now() - checkedAt > 5_000) throw new Error();
      if (!matches.length) return null;
      if (matches.length !== 1 || (matches[0].name !== `copy${intent.strategyId}` && matches[0].name !== data.message.agentName) ||
        matches[0].validUntil !== intent.expiresAt || intent.expiresAt <= this.now()) throw new Error();
      return { checkedAt, validUntil: intent.expiresAt };
    } catch (error) {
      const wait = sharedCapacityWait(error);
      if (wait) throw wait;
      throw new LiveBoundaryError("agent_approval_evidence_unavailable");
    }
  }
}
