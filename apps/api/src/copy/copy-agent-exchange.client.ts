import {HyperliquidGlobalTransport} from '../hyperliquid/hyperliquid-global-transport.js';
import {verifyTypedData} from 'viem';
import {boundedLiveRead} from './live/live-market-resolver.js';
import { PrivyClient } from "@privy-io/node";
import { WALLET_NETWORKS, splitSignature } from "@trading-dashboard/shared/contracts";
import { z } from "zod";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import { agentApprovalTypedData, type AgentConsentIntent } from "./copy-agent-consent.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";

export const AGENT_APPROVAL_CLIENT = Symbol("AGENT_APPROVAL_CLIENT");
export interface AgentApprovalClient {
  readonly available: boolean;
  acquire(): Promise<unknown>;
  signMaster(account: { walletId: string; address: string; ownerQuorumId: string }, intent: AgentConsentIntent, userJwt: string,assertFreshProof?:()=>void): Promise<string>;
  send(intent: AgentConsentIntent, signature: string,assertFreshProof?:()=>void): Promise<unknown>;
  observe(intent: AgentConsentIntent): Promise<{ checkedAt: number; validUntil: number } | null>;
}
const domainFields = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
const agents = z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(256),
  validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() })).max(100);

/** Fresh user authorization is used for one exact master approval. Neither the
 * JWT nor a reusable master authorization is persisted or passed to workers. */
export class PrivyAgentApprovalClient implements AgentApprovalClient {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(config: { appId?: string; appSecret?: string }, private readonly budget: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now,private readonly global?:HyperliquidGlobalTransport) {
    if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))throw new LiveBoundaryError("agent_approval_client_invalid");
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  get available() { return this.credentials !== null; }
  acquire() { return this.budget(1); }
  async signMaster(rawAccount:{walletId:string;address:string;ownerQuorumId:string},rawIntent:AgentConsentIntent,userJwt:string,assertFreshProof?:()=>void):Promise<string>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const account=Object.freeze(structuredClone(rawAccount)),intent=Object.freeze(structuredClone(rawIntent)),data=agentApprovalTypedData(intent),started=this.now(),deadline=Math.min(started+5000,intent.consentExpiresAt);
      const proof=()=>{const value:unknown=assertFreshProof?.();if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw new Error();}};
      const remaining=()=>{const now=this.now();if(!Number.isSafeInteger(now)||now<started||now<intent.nonce||now>=deadline||controller.signal.aborted)throw new Error();return deadline-now;};
      if(!this.credentials||typeof userJwt!=='string'||!userJwt.trim()||userJwt.length>32768||account.address.toLowerCase()!==intent.accountAddress.toLowerCase()||this.global&&typeof assertFreshProof!=='function')throw new Error();
      proof();remaining();timer=setTimeout(()=>controller.abort(),remaining());timer.unref();
      let verified=false,submitted=false;const walletPath=`/v1/wallets/${encodeURIComponent(account.walletId)}`,rpcPath=`${walletPath}/rpc`;
      const sdkFetch:typeof fetch=(input,init)=>{
        const url=new URL(input instanceof Request?input.url:String(input)),method=init?.method??(input instanceof Request?input.method:'GET');
        if(url.origin!=='https://api.privy.io'||url.search||url.hash||!(url.pathname===walletPath&&method==='GET'||url.pathname==='/v1/wallets/authenticate'&&method==='POST'||url.pathname===rpcPath&&method==='POST'))throw new Error();
        const request={...init,redirect:'error' as const,signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])])};
        remaining();if(url.pathname===rpcPath){if(!verified||submitted)throw new Error();proof();remaining();submitted=true;}
        const work=this.fetcher(input,request);
        return (async()=>{const response=await boundedLiveRead(work,remaining());if(!response.body)throw new Error();
          const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
          try{if(Number(response.headers.get('content-length'))>65536)throw new Error();for(;;){const {done,value}=await boundedLiveRead(reader.read(),remaining());if(done)break;bytes+=value.byteLength;if(bytes>65536)throw new Error();chunks.push(value);}
            return Response.json(JSON.parse(Buffer.concat(chunks,bytes).toString()),{status:response.status,headers:response.headers});
          }finally{controller.signal.removeEventListener('abort',abort);await boundedLiveRead(reader.cancel(),100).catch(()=>{});reader.releaseLock();}
        })();
      };
      const client=new PrivyClient({...this.credentials,timeout:remaining(),maxRetries:0,fetch:sdkFetch,logLevel:'off'});
      const wallet=await boundedLiveRead(client.wallets().get(account.walletId),remaining());
      if(wallet.id!==account.walletId||wallet.chain_type!=='ethereum'||typeof wallet.address!=='string'||wallet.address.toLowerCase()!==account.address.toLowerCase()||wallet.owner_id!==account.ownerQuorumId||wallet.archived_at!==null)throw new Error();verified=true;
      const result=await boundedLiveRead(client.wallets().ethereum().signTypedData(account.walletId,{address:account.address,authorization_context:{user_jwts:[userJwt]},request_expiry:intent.consentExpiresAt,params:{typed_data:{domain:data.domain,types:{...data.types,EIP712Domain:domainFields},primary_type:data.primaryType,message:data.message}}}),remaining());
      remaining();if(result.encoding!=='hex'||!/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(result.signature)||!await verifyTypedData({address:account.address as `0x${string}`,...data,signature:result.signature as `0x${string}`}))throw new Error();remaining();return result.signature;
    }catch{throw new LiveBoundaryError('agent_master_approval_unavailable');}finally{clearTimeout(timer);controller.abort();}
  }
  async send(rawIntent:AgentConsentIntent,signature:string,assertFreshProof?:()=>void):Promise<unknown>{
    const intent=Object.freeze(structuredClone(rawIntent)),data=agentApprovalTypedData(intent);
    if(this.now()>=intent.consentExpiresAt)throw new LiveBoundaryError('agent_consent_expired');
    try{
      const request:RequestInit={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:{type:'approveAgent',signatureChainId:WALLET_NETWORKS.testnet.signatureChainId,...data.message},nonce:intent.nonce,signature:splitSignature(signature)}),redirect:'error',signal:AbortSignal.timeout(10000)};
      if(this.global&&typeof assertFreshProof!=='function')throw new Error();
      const permit=this.global?await this.global.currentQuota().acquireRest(1,Math.min(this.now()+5000,intent.consentExpiresAt)):undefined;
      const dispatch=()=>{
        const result:unknown=assertFreshProof?.();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error();}
        permit?.assertFresh();if(this.now()<intent.nonce||this.now()>=intent.consentExpiresAt)throw new Error();
        return this.fetcher(WALLET_NETWORKS.testnet.exchangeUrl,request);
      };
      const response=await (permit?permit.dispatch(dispatch):dispatch());
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error();}return await readInfoJson(response,'agent approval submission',64*1024);
    }catch{throw new LiveBoundaryError('agent_approval_submission_unknown');}
  }
  async observe(intent: AgentConsentIntent): Promise<{ checkedAt: number; validUntil: number } | null> {
    const data = agentApprovalTypedData(intent);
    const checkedAt = this.now();
    try {
      // A strategy master must be a user account. Agents/vaults/subaccounts are
      // not interchangeable with an explicitly owned, funded master account.
      const role = await this.read({ type: "userRole", user: intent.accountAddress }, 60);
      if (!role || typeof role !== "object" || !("role" in role) || role.role !== "user") throw new Error();
      const list = agents.parse(await this.read({ type: "extraAgents", user: intent.accountAddress }, 20));
      const matches = list.filter(a => a.address.toLowerCase() === data.message.agentAddress);
      if (this.now() < checkedAt || this.now() - checkedAt > 5_000) throw new Error();
      if (!matches.length) return null;
      if (matches.length !== 1 || (matches[0].name !== `copy${intent.strategyId}` && matches[0].name !== data.message.agentName) ||
        matches[0].validUntil !== intent.expiresAt || intent.expiresAt <= this.now()) throw new Error();
      return { checkedAt, validUntil: intent.expiresAt };
    } catch { throw new LiveBoundaryError("agent_approval_evidence_unavailable"); }
  }
  private async read(body: { type: "userRole" | "extraAgents"; user: string }, weight: number) {
    await this.budget(weight);
    const response = await (this.global?.fetchInfo??this.fetcher)(WALLET_NETWORKS.testnet.infoUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
    return readInfoJson(response, "agent approval evidence", 64 * 1024);
  }
}
