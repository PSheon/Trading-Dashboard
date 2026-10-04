import {generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {PrivyAgentApprovalClient} from '../src/copy/copy-agent-exchange.client.js';
import {agentApprovalTypedData,type AgentConsentIntent} from '../src/copy/copy-agent-consent.js';
const require=createRequire(import.meta.url),cryptoSdk=require(join(dirname(require.resolve('@privy-io/node')),'lib/cryptography.js')) as {setupHPKESender():Promise<{encryptPayload(key:Uint8Array,payload:Uint8Array):Promise<{ciphertext:Uint8Array;encapsulatedKey:Uint8Array}>}>};
const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),master=privateKeyToAccount(`0x${'01'.repeat(32)}`),time=Date.now();
const intent:AgentConsentIntent={id:'operation',strategyId:1,network:'testnet',accountAddress:master.address.toLowerCase(),agentAddress:`0x${'22'.repeat(20)}`,policyId:'policy',workerQuorumId:'worker',nonce:time,expiresAt:time+86400000,consentExpiresAt:time+300000};
const account={walletId:'master',address:intent.accountAddress,ownerQuorumId:'owner'};
function fixture(onAuth=()=>{},onRpc=()=>{}){
 let now=time;const requests:string[]=[],rpc:Record<string,unknown>[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));requests.push(url.pathname);const body=JSON.parse(String(init?.body??'{}'));
  if(url.pathname==='/v1/wallets/master')return Response.json({id:'master',address:master.address,chain_type:'ethereum',owner_id:'owner',archived_at:null});
  if(url.pathname==='/v1/wallets/authenticate'){
   onAuth();const recipient=await crypto.subtle.importKey('spki',Buffer.from(body.recipient_public_key,'base64'),{name:'ECDH',namedCurve:'P-256'},true,[]),raw=new Uint8Array(await crypto.subtle.exportKey('raw',recipient)),sender=await cryptoSdk.setupHPKESender(),encrypted=await sender.encryptPayload(raw,new TextEncoder().encode(key));
   return Response.json({expires_at:time+600000,encrypted_authorization_key:{encryption_type:'HPKE',encapsulated_key:Buffer.from(encrypted.encapsulatedKey).toString('base64'),ciphertext:Buffer.from(encrypted.ciphertext).toString('base64')}});
  }
  if(url.pathname==='/v1/wallets/master/rpc'){onRpc();rpc.push(body);const data=agentApprovalTypedData(intent),signature=await master.signTypedData(data);return Response.json({method:'eth_signTypedData_v4',data:{encoding:'hex',signature}});}
  throw Error('unexpected request');
 };
 vi.stubGlobal('fetch',fetcher);return {requests,rpc,client:new PrivyAgentApprovalClient({appId:'offline-app',appSecret:'offline-secret'},async()=>{},fetcher,()=>now),advance:()=>{now+=5001;}};
}
afterEach(()=>vi.unstubAllGlobals());
describe('real installed SDK principal agent approval boundary, mocked HTTP only',()=>{
 it('checks local proof after invocation-scoped HPKE exchange at actual RPC',async()=>{
  let fresh=true;const f=fixture(()=>{fresh=false;}),proof=vi.fn(()=>{if(!fresh)throw Error('local proof lost');});
  await expect(f.client.signMaster(account,intent,'jwt',proof)).rejects.toThrow('agent_master_approval_unavailable');expect(f.requests).toEqual(['/v1/wallets/master','/v1/wallets/authenticate']);expect(proof).toHaveBeenCalledTimes(2);
 });
 it('rejects proof that consumes the last five seconds before actual RPC fetch',async()=>{
  const f=fixture(),proof=vi.fn(()=>{if(proof.mock.calls.length===2)f.advance();});
  await expect(f.client.signMaster(account,intent,'jwt',proof)).rejects.toThrow('agent_master_approval_unavailable');expect(f.requests).not.toContain('/v1/wallets/master/rpc');
 });
 it('signs captured canonical scope when caller mutates original account and intent during authorization',async()=>{
  const original=structuredClone(intent),owner=structuredClone(account),f=fixture(()=>{original.agentAddress=`0x${'33'.repeat(20)}`;owner.address=`0x${'44'.repeat(20)}`;});
  await expect(f.client.signMaster(owner,original,'jwt',()=>{})).resolves.toMatch(/^0x[0-9a-f]{130}$/i);
  expect((f.rpc[0]!.params as any).typed_data.message).toEqual(agentApprovalTypedData(intent).message);expect(f.rpc[0]!.address).toBe(intent.accountAddress);
 });
 it('rejects an asynchronous proof hook before initiating any SDK transport',async()=>{
  const f=fixture();await expect(f.client.signMaster(account,intent,'jwt',async()=>{})).rejects.toThrow('agent_master_approval_unavailable');expect(f.requests).toEqual([]);
 });
});
