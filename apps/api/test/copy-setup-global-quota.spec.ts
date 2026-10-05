import {afterEach,describe,expect,it,vi} from 'vitest';
import {PrivyAccountModeClient,type AccountModeIntent} from '../src/copy/live/privy-account-mode-client.js';
import {PrivyAgentApprovalClient} from '../src/copy/copy-agent-exchange.client.js';
import {CopyFundingExchangeClient} from '../src/copy/copy-funding-exchange.client.js';
import type {AgentConsentIntent} from '../src/copy/copy-agent-consent.js';
import type {FundingRow} from '../src/copy/copy-funding.repository.js';
import type {RequestBudgeterService} from '../src/hyperliquid/request-budgeter.service.js';
import {offlineGlobalTransport} from './hyperliquid-global-test-utils.js';
const address=`0x${'11'.repeat(20)}`,signature=`0x${'11'.repeat(64)}1b`;
function fixture(){
 let now=Date.now();const started=now,budget=vi.fn(async(_weight:number)=>{}),fetcher=vi.fn<typeof fetch>(async(_input,init)=>{
  const body=JSON.parse(String(init?.body));return Response.json(body.type==='userRole'?{role:'user'}:body.type==='userAbstraction'?'disabled':body.type==='userDexAbstraction'?false:body.type==='spotClearinghouseState'?{balances:[],portfolioMarginEnabled:false}:body.type==='extraAgents'?[]:body.type==='clearinghouseState'?{withdrawable:'100'}:body.type==='txDetails'?{type:'txDetails',tx:{}}:{status:'ok',response:{type:'default'}});
 });vi.stubGlobal('fetch',fetcher);const global=offlineGlobalTransport(fetcher,()=>now);
 const modeIntent:AccountModeIntent={operationId:'mode',accountId:'account',strategyId:1,network:'testnet',accountAddress:address,nonce:started,consentExpiresAt:started+300000};
 const agentIntent:AgentConsentIntent={id:'agent',strategyId:1,network:'testnet',accountAddress:address,agentAddress:`0x${'22'.repeat(20)}`,policyId:'policy',workerQuorumId:'worker',nonce:started,expiresAt:started+86400000,consentExpiresAt:started+300000};
 const operation={id:'funding',userId:1,accountId:'account',strategyId:1,network:'testnet',address,destination:`0x${'22'.repeat(20)}`,amount:'1',nonce:started,status:'unknown',attemptedAt:new Date(started)} as FundingRow;
 const mode=new PrivyAccountModeClient({},budget,fetcher,()=>now,global.transport),agent=new PrivyAgentApprovalClient({},budget,fetcher,()=>now,global.transport),funding=new CopyFundingExchangeClient({acquire:budget} as unknown as RequestBudgeterService,global.transport);
 return {global,mode,agent,funding,modeIntent,agentIntent,operation,fetcher,advance:()=>{now+=5001;}};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('registered setup clients share durable quota at actual transport',()=>{
 it('routes every readonly mode/approval/balance/explorer read through fixed-network global dispatch',async()=>{
  const f=fixture();await f.mode.observe(f.modeIntent);await f.agent.observe(f.agentIntent);await f.funding.available(f.operation);await f.funding.txDetails('testnet',`0x${'aa'.repeat(32)}`);
  // The mode observation's four reads are one meter charge (102), the agent's two one (80), sent together.
  expect(f.global.acquire.mock.calls.map(([weight])=>weight).sort((a,b)=>a-b)).toEqual([2,40,80,102]);expect(f.fetcher).toHaveBeenCalledTimes(8);
 });
 it.each(['mode','agent','funding'] as const)('denies %s exchange POST when global quota denies, retaining unknown rather than retrying',async kind=>{
  const f=fixture();f.global.acquire.mockRejectedValueOnce(Error('private provider quota detail'));
  const work=kind==='mode'?f.mode.send(f.modeIntent,signature,()=>{}):kind==='agent'?f.agent.send(f.agentIntent,signature,()=>{}):f.funding.send(f.operation,signature,()=>{});
  await expect(work).rejects.toThrow(kind!=='funding'?/not_dispatched/:/submission_unknown/);expect(f.fetcher).not.toHaveBeenCalled();expect(f.global.acquire).toHaveBeenCalledWith(1,expect.any(Number));
 });
 it.each(['mode','agent','funding'] as const)('rechecks the same %s quota permit after costly final proof with no transport gap',async kind=>{
  const f=fixture(),guard=vi.fn(()=>{f.advance();});
  const work=kind==='mode'?f.mode.send(f.modeIntent,signature,guard):kind==='agent'?f.agent.send(f.agentIntent,signature,guard):f.funding.send(f.operation,signature,guard);
  await expect(work).rejects.toThrow(kind!=='funding'?/not_dispatched/:/submission_unknown/);expect(guard).toHaveBeenCalledOnce();expect(f.fetcher).not.toHaveBeenCalled();expect(f.global.acquire).toHaveBeenCalledOnce();
 });
 it.each(['mode','agent','funding'] as const)('sends %s once after private quota and synchronous proof without adding JWT fields',async kind=>{
  const f=fixture(),guard=vi.fn();const work=kind==='mode'?f.mode.send(f.modeIntent,signature,guard):kind==='agent'?f.agent.send(f.agentIntent,signature,guard):f.funding.send(f.operation,signature,guard);
  await expect(work).resolves.toMatchObject({status:'ok'});expect(f.global.acquire).toHaveBeenCalledOnce();expect(f.fetcher).toHaveBeenCalledOnce();expect(guard).toHaveBeenCalledOnce();
  expect(String(f.fetcher.mock.calls[0]![1]?.body)).not.toContain('jwt');expect(f.fetcher.mock.calls[0]![1]?.redirect).toBe('error');
 });
 it.each(['mode','agent','funding'] as const)('fails closed for %s global configured send without a captured local proof callback',async kind=>{
  const f=fixture();const work=kind==='mode'?f.mode.send(f.modeIntent,signature):kind==='agent'?f.agent.send(f.agentIntent,signature):f.funding.send(f.operation,signature);
  await expect(work).rejects.toThrow(kind!=='funding'?/not_dispatched/:/submission_unknown/);expect(f.fetcher).not.toHaveBeenCalled();
 });
});
