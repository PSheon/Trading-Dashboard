import { describe, expect, it } from 'vitest';
import { followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { canonicalLiveSourceLegs, parseLiveSourceFill, liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import { combinedCloseFraction, planLiveSourceOrder, type LiveSourcePlanInput } from '../src/copy/live/copy-live-source-planner.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
import { Dec } from '../src/common/decimal/dec.js';
import { settledGenerationExample, sourceSizingExample } from './copy-live-generation-test-utils.js';
const example=sourceSizingExample;
function closeExample(position='90',carry='15',full=false,mode:'fixed'|'ratio'='fixed'):LiveSourcePlanInput{
  const e=structuredClone(example(mode)),history=settledGenerationExample(position),manifest=history.manifest as any,o=(e.sizingBasis as any).observations,b=(e.sizingBasis as any).basis;
  (e as any).now=history.now;(e as any).currentExecutionKey=history.currentExecutionKey;manifest.journals[0].provenance.settingsDigest=e.mandate.settingsDigest;
  manifest.carry[0].carry=carry;manifest.carry[0].revision=2;
  o.follower=history.snapshot;o.generationManifest=manifest;
  const fill=parseLiveSourceFill({tid:2,oid:8,time:e.now-50,coin:'BTC',side:'A',px:'100',sz:full?'4':'1',startPosition:'4'}, {network:'testnet',leaderAddress:e.mandate.leaderAddress,from:e.now-1000,to:e.now,receivedAt:e.now,kind:'fills'});
  (e as any).fill=fill;(e as any).leg=canonicalLiveSourceLegs(fill)[0];
  Object.assign(b,{sourceFillId:fill.id,sourceDigest:fill.sourceDigest,leg:'close',fixedTradeClaim:false,carry:{amount:carry,revision:2}});
  if(mode==='ratio'){b.leader=null;o.leader=null;} // a close is not sized by the leader's capital
  Object.assign(b.follower,{positionSize:position,observedAt:history.snapshot.observedAt,completedAt:history.snapshot.completedAt,snapshotDigest:followerReceiptDigestV1(history.snapshot),positionsDigest:liveSourceDigest({BTC:position})});
  Object.assign(b.generation,{positionSize:position,receiptManifestDigest:liveSourceDigest({receipts:manifest.receipts,ledger:manifest.ledger}),positionsDigest:liveSourceDigest({BTC:position})});
  return e;
}
describe('actual source sizing from retained original observations',()=>{
  it.each(['fixed','ratio'] as const)('plans conservative %s IOC from actual equity and exact owner budget',mode=>{
    expect(planLiveSourceOrder(example(mode))).toMatchObject({plannerVersion:1,order:{coin:'BTC',side:'B',size:mode==='fixed'?'0.09':'0.1',limitPrice:'100.5',reduceOnly:false,timeInForce:'Ioc'}});
  });
  it('keeps a fixed opening inside the owner budget even at the highest permitted buy fill price',()=>{
    const e=example(),order=planLiveSourceOrder(e).order;
    expect(Dec.from(order.size).mul(order.limitPrice).lte(e.settings.perTradeUsd!)).toBe(true);
    expect(Dec.from(order.size).add('0.01').mul(order.limitPrice).gt(e.settings.perTradeUsd!)).toBe(true);
  });
  it('does not enlarge a reverse fixed sell because its admitted limit is below the mid',()=>{
    const e=example('fixed','reverse'),order=planLiveSourceOrder(e).order;
    expect(order).toMatchObject({side:'A',size:'0.1',limitPrice:'99.5'});
    expect(Dec.from(order.size).mul('100').lte(e.settings.perTradeUsd!)).toBe(true);
  });
  it.each(['scalar','snapshot','source','leader','quote','generation','time','budget','settings','adopt','cursor','fixedClaim','extra'] as const)('rejects %s substitution',kind=>{
    const e=structuredClone(example('ratio')), envelope=e.sizingBasis as LiveSourceSizingEnvelopeV1,b=envelope.basis as any;
    if(kind==='scalar')b.follower.equity='10000';
    if(kind==='snapshot')(envelope.observations.follower as any).perpEquity='10000';
    if(kind==='source')b.sourceDigest='c'.repeat(64);
    if(kind==='leader')b.leader.network='mainnet';
    if(kind==='quote')b.quote.midPrice='1';
    if(kind==='generation')b.generation.positionSize='10';
    if(kind==='time')(e as any).now+=5001;
    if(kind==='budget')b.budgetUsd='1000';
    if(kind==='settings')(e.settings as any).direction='reverse';
    if(kind==='adopt')(e.settings as any).copyStartMode='adopt';
    if(kind==='cursor')e.mandate.activationCursor=new Date(e.fill.providerTime+1);
    if(kind==='fixedClaim')b.fixedTradeClaim=true;
    if(kind==='extra')b.paperCash='1000';
    expect(()=>planLiveSourceOrder(e)).toThrow();
  });
  it('refuses compact-only scalars as sizing evidence',()=>{const e=example();(e as any).sizingBasis=(e.sizingBasis as LiveSourceSizingEnvelopeV1).basis;expect(()=>planLiveSourceOrder(e)).toThrow();});
  it('reduces only the independently reconstructed generation position, applying a fraction to quantity not already owed',()=>{
    expect(planLiveSourceOrder(closeExample())).toMatchObject({order:{side:'A',size:'33.75',reduceOnly:true},nextCarry:'0'});
  });
  it('retains rounding dust after a subsequent fraction with a genuine partial-fill carry',()=>{
    // Prior desired33.75, actualfilled10 -> remaining80 and owed23.75.
    expect(planLiveSourceOrder(closeExample('80','23.75'))).toMatchObject({order:{size:'37.81',reduceOnly:true},nextCarry:'0.0025'});
  });
  it('fully closes the actual remaining generation quantity and clears carry',()=>{
    expect(planLiveSourceOrder(closeExample('80','23.75',true))).toMatchObject({order:{size:'80',reduceOnly:true},nextCarry:'0'});
  });
  it.each(['amount','revision','absent','wrongSign'] as const)('refuses close carry/position %s substitution',kind=>{
    const e=closeExample(),b=(e.sizingBasis as any).basis,o=(e.sizingBasis as any).observations;
    if(kind==='amount')b.carry.amount='90';
    if(kind==='revision')b.carry.revision++;
    if(kind==='absent')o.generationManifest.carry=[];
    if(kind==='wrongSign')b.generation.positionSize='-90';
    expect(()=>planLiveSourceOrder(e)).toThrow();
  });
  it.each(['B','A'] as const)('rounds %s limit prices within the original signed slippage bound',side=>{
    const e=side==='B'?example():closeExample(),b=(e.sizingBasis as any).basis,o=(e.sizingBasis as any).observations,mid=side==='B'?'100.005':'100.995';
    b.quote.midPrice=mid;o.quote.quote.midPrice=mid;
    expect(planLiveSourceOrder(e).order.limitPrice).toBe('100.5');
  });
  describe('one adjustment for several same-coin leader legs', () => {
    /** The order's own leg plus `others` more legs like it, in leader-time order. */
    function merged(e: LiveSourcePlanInput, others: number, fraction: string | null = null) {
      const b = (e.sizingBasis as any).basis, own = { sourceFillId: e.fill.id, sourceDigest: e.fill.sourceDigest, providerTime: e.fill.providerTime, sign: e.leg.sign,
        size: e.leg.size, px: e.fill.px, fraction: e.leg.fraction };
      // The older legs first; the order's own (the freshest) last.
      b.merged = { members: [...Array.from({ length: others }, (_, i) => ({ ...own, sourceFillId: `mainnet:${'0x'}:${i + 1}`, sourceDigest: 'd'.repeat(64),
        providerTime: e.fill.providerTime - others + i, ...(fraction ? { fraction } : {}) })), own] };
      return e;
    }
    it('sizes five same-side opens as one order of their summed leader notional', () => {
      const single = planLiveSourceOrder(example('ratio')).order.size;
      expect(planLiveSourceOrder(merged(example('ratio'), 4)).order).toMatchObject({ size: Dec.from(single).mul(5).toString(), side: 'B', reduceOnly: false });
    });
    it('closes the combined fraction 1 - (1 - f1)(1 - f2) of what is held, and a full close fully', () => {
      expect(combinedCloseFraction(['0.25', '0.25']).toString()).toBe('0.4375');
      expect(combinedCloseFraction(['0.5', '1']).toString()).toBe('1');
      // Owed 15, then 0.4375 of the other 75: 47.8125, floored at the lot.
      expect(planLiveSourceOrder(merged(closeExample('90', '15', false, 'ratio'), 1))).toMatchObject({ order: { size: '47.81', reduceOnly: true }, nextCarry: '0.0025' });
      expect(planLiveSourceOrder(merged(closeExample('90', '15', false, 'ratio'), 1, '1'))).toMatchObject({ order: { size: '90', reduceOnly: true }, nextCarry: '0' });
    });
    it('carries older legs that waited up to 15 minutes, but not longer', () => {
      const e = merged(example('ratio'), 2), members = (e.sizingBasis as any).basis.merged.members;
      members[0].providerTime = e.now - 14 * 60_000; members[1].providerTime = e.now - 13 * 60_000;
      (e.mandate as any).activationCursor = new Date(e.now - 20 * 60_000);
      expect(planLiveSourceOrder(e).order.size).toBe(Dec.from(planLiveSourceOrder(example('ratio')).order.size).mul(3).toString());
      members[0].providerTime = e.now - 15 * 60_000 - 1;
      expect(() => planLiveSourceOrder(e)).toThrow('live_source_sizing_unproven');
    });
    it.each(['fixed', 'missing own leg', 'own leg not newest', 'other side', 'unsorted', 'before cursor'] as const)('refuses a merged basis with %s', kind => {
      const e = merged(example(kind === 'fixed' ? 'fixed' : 'ratio'), 2), members = (e.sizingBasis as any).basis.merged.members;
      if (kind === 'missing own leg') members[2].sourceDigest = 'e'.repeat(64);
      if (kind === 'own leg not newest') members[1].providerTime = e.fill.providerTime + 1;
      if (kind === 'other side') members[1].sign = -members[1].sign;
      if (kind === 'unsorted') [members[0], members[1]] = [members[1], members[0]];
      if (kind === 'before cursor') members[0].providerTime = e.mandate.activationCursor!.getTime();
      expect(() => planLiveSourceOrder(e)).toThrow('live_source_sizing_unproven');
    });
  });
});
