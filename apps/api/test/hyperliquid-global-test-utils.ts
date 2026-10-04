import {vi} from 'vitest';
import {HyperliquidGlobalTransport} from '../src/hyperliquid/hyperliquid-global-transport.js';
import {PostgresHyperliquidQuota,type BoundHyperliquidQuota} from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import {UnitOfWork} from '../src/db/unit-of-work.js';
import type {DrizzleDb} from '../src/db/drizzle.provider.js';
/** Offline port fixture only. Genuine durable admission/capability tests live in
 * hyperliquid-global-quota-postgres.spec.ts. Every issued mock is finite. */
export function offlineGlobalTransport(fetcher:typeof fetch,now=Date.now){
 const quota=new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
 const acquire=vi.fn<BoundHyperliquidQuota['acquireRest']>(async(_weight,deadline)=>{
  let used=false,running=false;const assertFresh=()=>{if(now()>=deadline)throw Error('quota expired');if(used&&!running)throw Error('quota reused');};
  return {assertFresh,dispatch:<T>(work:()=>T):T=>{assertFresh();if(used)throw Error('quota reused');used=true;running=true;try{return work();}finally{running=false;}}};
 });
 vi.spyOn(quota,'bindUnscoped').mockReturnValue({acquireRest:acquire,reserveSocket:vi.fn()});
 return {acquire,transport:new HyperliquidGlobalTransport(quota,{egressKey:'offline-explicit-shared-egress',ownerId:'offline-client'},fetcher,now)};
}
