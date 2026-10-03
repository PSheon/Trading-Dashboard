import { expect,it } from 'vitest';
import { calculateLiveExternalExposure } from '../src/copy/live/live-external-exposure.js';
import { fixture,now } from './copy-live-risk-test-utils.js';
import type { LiveRiskReservation } from '../src/copy/live/live-account-risk.js';
import type { LiveObservedRestingOrder } from '../src/copy/live/live-account-observer.js';
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const order=():LiveObservedRestingOrder=>({coin:'BTC',dex:'',asset:0,oid:'10',side:'B',limitPrice:'100',remainingSize:'0.5',originalSize:'1',notionalUsd:'50',reduceOnly:false,timestamp:now,cloid:fixture().intent.cloid});
function data(){const f=fixture();return {now,accountId:'account',accountAddress:f.identity.accountAddress,coin:'BTC',riskPrice:'150',snapshot:structuredClone(f.accountSource.snapshot) as Mutable<typeof f.accountSource.snapshot>,reservations:[] as LiveRiskReservation[]};}
it('marks target resting and held exposure at the exact higher current price',()=>{
  const input=data();input.snapshot.restingOrders=[order()];
  input.reservations=[];expect(calculateLiveExternalExposure(input)).toEqual({exposureUsd:'75',coinExposureUsd:'75'});
  input.snapshot.restingOrders=[];input.reservations=[fixture().reservations.own];expect(calculateLiveExternalExposure(input)).toEqual({exposureUsd:'150',coinExposureUsd:'150'});
});
it('preserves exact upward rounding beyond 18 decimal products',()=>{
  const input=data();input.riskPrice='100.000000000000000001';input.snapshot.restingOrders=[{...order(),remainingSize:'0.1',notionalUsd:'10'}];
  expect(calculateLiveExternalExposure(input)).toEqual({exposureUsd:'10.000000000000000001',coinExposureUsd:'10.000000000000000001'});
});
it('counts actual signed positions without predicting reductions',()=>{
  const input=data();input.snapshot.positions=[{coin:'BTC',dex:'',asset:0,sizeDecimals:2,size:'-1',entryPrice:'100',positionValue:'100',unrealizedPnl:'0',marginUsed:'10',leverage:10,leverageType:'cross',maxLeverage:20,fundingSinceOpen:'0',fundingSinceChange:'0'}];
  input.snapshot.restingOrders=[{...order(),side:'B',reduceOnly:true}];expect(calculateLiveExternalExposure(input)).toEqual({exposureUsd:'150',coinExposureUsd:'150'});
});
it('deduplicates a precisely matched actual resting order and keeps its remaining marked quantity',()=>{
  const input=data();input.snapshot.restingOrders=[order()];input.reservations=[{...fixture().reservations.own,state:'resting',exchangeOrderId:'10'}];
  expect(calculateLiveExternalExposure(input)).toEqual({exposureUsd:'75',coinExposureUsd:'75'});
});
it.each(['coin','dex','asset','side','reduceOnly','limitPrice','originalSize','cloid'] as const)('rejects contradictory %s when the OID points to another order',field=>{
  const input=data(),actual:any=order();actual[field]=field==='coin'?'ETH':field==='dex'?'xyz':field==='asset'?1:field==='side'?'A':field==='reduceOnly'?true:field==='limitPrice'?'101':field==='originalSize'?'2':`0x${'ee'.repeat(16)}`;
  input.snapshot.restingOrders=[actual];input.reservations=[{...fixture().reservations.own,state:'resting',exchangeOrderId:'10'}];expect(()=>calculateLiveExternalExposure(input)).toThrow('live_risk_liability_conflict');
});
it('rejects an OID/cloid pair that maps to two different actual orders',()=>{
  const input=data();input.snapshot.restingOrders=[{...order(),oid:'11'}, {...order(),cloid:`0x${'cc'.repeat(16)}`}];input.reservations=[{...fixture().reservations.own,state:'resting',exchangeOrderId:'10'}];
  expect(()=>calculateLiveExternalExposure(input)).toThrow('live_risk_liability_conflict');
});
it.each(['oid','cloid'] as const)('rejects duplicate actual order %s identity',field=>{
  const input=data();input.snapshot.restingOrders=[order(),{...order(),oid:field==='oid'?'10':'11',cloid:field==='cloid'?order().cloid:`0x${'cc'.repeat(16)}`}];
  expect(()=>calculateLiveExternalExposure(input)).toThrow('live_risk_liability_conflict');
});
it.each(['unknown','missingResting','unattemptedVisible'] as const)('retains uncertainty for %s liabilities',kind=>{
  const input=data();input.reservations=[{...fixture().reservations.own,state:kind==='unknown'?'unknown':kind==='missingResting'?'resting':'held',exchangeOrderId:kind==='missingResting'?'10':null}];
  if(kind==='unattemptedVisible')input.snapshot.restingOrders=[order()];expect(()=>calculateLiveExternalExposure(input)).toThrow('live_risk_liability_unknown');
});
it('does not apply a BTC mark to another coin and keeps all external exposure',()=>{
  const input=data();input.snapshot.restingOrders=[{...order(),coin:'ETH',asset:1}];expect(calculateLiveExternalExposure(input)).toEqual({exposureUsd:'50',coinExposureUsd:'0'});
});
it('rejects foreign account or network evidence and expired held liability without erasing it',()=>{
  const input=data();input.snapshot.accountAddress=`0x${'66'.repeat(20)}`;expect(()=>calculateLiveExternalExposure(input)).toThrow('live_risk_identity');
  const other=data();other.reservations=[{...fixture().reservations.own,expiresAt:now}];expect(()=>calculateLiveExternalExposure(other)).toThrow('live_risk_liability_unknown');
});
