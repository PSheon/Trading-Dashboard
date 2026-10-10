import { describe, expect, it, vi } from 'vitest';
import { PerReadAllDexsAccountSource, type LiveAllDexsAccountSource, type LiveAllDexsOrderEvidence } from '../src/copy/live/live-account-ws-source.js';

const user=`0x${'22'.repeat(20)}`,at=1_790_000_000_000;
const dexes=Array.from({length:268},(_,i)=>i?`venue${i}`:'');
function fixture(change?: (proof: LiveAllDexsOrderEvidence)=>LiveAllDexsOrderEvidence,slowFirst=false,maxSockets=2,changePart?:number){
 const closes:ReturnType<typeof vi.fn>[]=[];const signals:(AbortSignal|undefined)[]=[];
 const proof=(requested:readonly string[],offset=0):LiveAllDexsOrderEvidence=>({network:'testnet',accountAddress:user,observedAt:at+offset,completedAt:at+offset+10,requestedDexes:[...requested],
  venues:requested.map(dex=>({dex,user,observedAt:at+offset,receivedAt:at+offset+5,orders:[]}))});
 const create=vi.fn(():LiveAllDexsAccountSource=>{
  const part=closes.length;
  const close=vi.fn();closes.push(close);
  return {close,read:async()=>({network:'testnet',accountAddress:user,observedAt:at,data:{}}),
   readAccount:async(_user,requested,_timeout,signal)=>{signals.push(signal);if(slowFirst)await new Promise(resolve=>setTimeout(resolve,25));return {state:{network:'testnet',accountAddress:user,observedAt:at,data:{unchanged:'original-state'}},orders:proof(requested)};},
   readOrders:async(_user,requested,_timeout,signal)=>{signals.push(signal);const value=proof(requested,3);return change&&(changePart===undefined||changePart===part)?change(value):value;}};
 });
 return {source:new PerReadAllDexsAccountSource(create,maxSockets),create,closes,signals};
}
describe('parallel all-venue reads retain original evidence',()=>{
 it('joins both complete sets without restamping either source or changing the aggregate state',async()=>{
  const f=fixture(),result=await f.source.readAccount(user,dexes,5000);
  expect(f.create).toHaveBeenCalledTimes(2);expect(f.closes.every(close=>close.mock.calls.length===1)).toBe(true);
  expect(result.state).toEqual({network:'testnet',accountAddress:user,observedAt:at,data:{unchanged:'original-state'}});
  expect(result.orders).toMatchObject({observedAt:at,completedAt:at+13,requestedDexes:dexes});
  expect(result.orders.venues.map(v=>v.dex)).toEqual(dexes);
  expect(result.orders.venues[134]).toMatchObject({observedAt:at+3,receivedAt:at+8});
 });
 it.each([
  ['network',(p:LiveAllDexsOrderEvidence)=>({...p,network:'mainnet' as const})],
  ['account',(p:LiveAllDexsOrderEvidence)=>({...p,accountAddress:`0x${'33'.repeat(20)}`})],
  ['requested coverage',(p:LiveAllDexsOrderEvidence)=>({...p,requestedDexes:p.requestedDexes.slice(1)})],
  ['venue coverage',(p:LiveAllDexsOrderEvidence)=>({...p,venues:p.venues.slice(1)})],
  ['source clock',(p:LiveAllDexsOrderEvidence)=>({...p,observedAt:p.completedAt+1})],
  ['venue start',(p:LiveAllDexsOrderEvidence)=>({...p,venues:p.venues.map((v,i)=>i?v:{...v,observedAt:p.observedAt-1})})],
  ['venue completion',(p:LiveAllDexsOrderEvidence)=>({...p,venues:p.venues.map((v,i)=>i?v:{...v,receivedAt:p.completedAt+1})})],
 ] as const)('refuses a second source with invalid %s, after cleaning both sockets',async(_name,change)=>{
  const f=fixture(change);await expect(f.source.readAccount(user,dexes,5000)).rejects.toThrow('live_account_source_mismatch');
  expect(f.closes).toHaveLength(2);expect(f.closes.every(close=>close.mock.calls.length===1)).toBe(true);
 });
 it('waits for both independent cleanups if one source fails',async()=>{
  const f=fixture(()=>{throw Error('offline_second_source_failed');},true);
  await expect(f.source.readAccount(user,dexes,5000)).rejects.toThrow('offline_second_source_failed');
  expect(f.closes).toHaveLength(2);expect(f.closes.every(close=>close.mock.calls.length===1)).toBe(true);
 });
 it('rejects a duplicated venue across parts before opening either socket',async()=>{
  const f=fixture();await expect(f.source.readAccount(user,[...dexes.slice(0,-1),dexes[0]!],5000)).rejects.toThrow('live_account_duplicate_evidence');
  expect(f.create).not.toHaveBeenCalled();
 });
 it('uses one socket for a small venue set',async()=>{
  const f=fixture();expect((await f.source.readAccount(user,dexes.slice(0,2),5000)).orders.requestedDexes).toEqual(dexes.slice(0,2));
  expect(f.create).toHaveBeenCalledOnce();
 });
 it('carries abandonment to both independent readers',async()=>{
  const f=fixture(),controller=new AbortController();await f.source.readAccount(user,dexes,5000,controller.signal);
  expect(f.signals).toEqual([controller.signal,controller.signal]);
 });
 it('opens no socket for an already abandoned read',async()=>{
  const f=fixture();await expect(f.source.readAccount(user,dexes,5000,AbortSignal.abort())).rejects.toThrow('live_account_read_abandoned');
  expect(f.create).not.toHaveBeenCalled();
 });
 it('joins three disjoint bounded parts with one original aggregate and every venue timestamp retained',async()=>{
  const f=fixture(undefined,false,3),result=await f.source.readAccount(user,dexes,5000);
  expect(f.create).toHaveBeenCalledTimes(3);expect(f.closes.every(close=>close.mock.calls.length===1)).toBe(true);
  expect(result.state).toEqual({network:'testnet',accountAddress:user,observedAt:at,data:{unchanged:'original-state'}});
  expect(result.orders).toMatchObject({observedAt:at,completedAt:at+13,requestedDexes:dexes});
  expect(result.orders.venues.map(v=>v.dex)).toEqual(dexes);
  expect(new Set(result.orders.venues.map(v=>v.dex)).size).toBe(dexes.length);
  expect(result.orders.venues[90]).toMatchObject({observedAt:at+3,receivedAt:at+8});
  expect(result.orders.venues[180]).toMatchObject({observedAt:at+3,receivedAt:at+8});
 });
 it.each([
  ['network',(p:LiveAllDexsOrderEvidence)=>({...p,network:'mainnet' as const})],
  ['account',(p:LiveAllDexsOrderEvidence)=>({...p,accountAddress:`0x${'33'.repeat(20)}`})],
  ['requested coverage',(p:LiveAllDexsOrderEvidence)=>({...p,requestedDexes:p.requestedDexes.slice(1)})],
  ['venue coverage',(p:LiveAllDexsOrderEvidence)=>({...p,venues:p.venues.slice(1)})],
  ['source clock',(p:LiveAllDexsOrderEvidence)=>({...p,observedAt:p.completedAt+1})],
  ['venue start',(p:LiveAllDexsOrderEvidence)=>({...p,venues:p.venues.map((v,i)=>i?v:{...v,observedAt:p.observedAt-1})})],
  ['venue completion',(p:LiveAllDexsOrderEvidence)=>({...p,venues:p.venues.map((v,i)=>i?v:{...v,receivedAt:p.completedAt+1})})],
 ] as const)('refuses invalid third-part %s and awaits every original cleanup',async(_name,change)=>{
  const f=fixture(change,false,3,2);await expect(f.source.readAccount(user,dexes,5000)).rejects.toThrow('live_account_source_mismatch');
  expect(f.closes).toHaveLength(3);expect(f.closes.every(close=>close.mock.calls.length===1)).toBe(true);
 });
 it('waits for all three cleanups after only the third reader fails',async()=>{
  const f=fixture(()=>{throw Error('offline_third_source_failed');},true,3,2);
  await expect(f.source.readAccount(user,dexes,5000)).rejects.toThrow('offline_third_source_failed');
  expect(f.closes).toHaveLength(3);expect(f.closes.every(close=>close.mock.calls.length===1)).toBe(true);
 });
 it('carries the original abandonment signal to all three readers',async()=>{
  const f=fixture(undefined,false,3),controller=new AbortController();await f.source.readAccount(user,dexes,5000,controller.signal);
  expect(f.signals).toEqual([controller.signal,controller.signal,controller.signal]);
 });
 it('keeps a small venue set on one socket even with a three-socket bound',async()=>{
  const f=fixture(undefined,false,3);expect((await f.source.readAccount(user,dexes.slice(0,2),5000)).orders.requestedDexes).toEqual(dexes.slice(0,2));
  expect(f.create).toHaveBeenCalledOnce();
 });
 it.each([0,4,1.5])('rejects unsupported socket bound %s',maxSockets=>{
  expect(()=>fixture(undefined,false,maxSockets)).toThrow('live_account_invalid_observer');
 });
});
