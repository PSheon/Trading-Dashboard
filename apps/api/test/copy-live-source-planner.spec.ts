import { describe, expect, it } from 'vitest';
import { followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
import { canonicalLiveSourceLegs, parseLiveSourceFill, liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import { planLiveSourceOrder, type LiveSourcePlanInput } from '../src/copy/live/copy-live-source-planner.js';
import type { LiveSourceSizingEnvelopeV1 } from '../src/copy/live/copy-live-sizing-evidence.js';
import { Dec } from '../src/common/decimal/dec.js';
import { settledGenerationExample, sourceSizingExample } from './copy-live-generation-test-utils.js';
const example=sourceSizingExample;
function closeExample(position='90',carry='15',full=false):LiveSourcePlanInput{
  const e=structuredClone(example()),history=settledGenerationExample(position),manifest=history.manifest as any,o=(e.sizingBasis as any).observations,b=(e.sizingBasis as any).basis;
  (e as any).now=history.now;(e as any).currentExecutionKey=history.currentExecutionKey;manifest.journals[0].provenance.settingsDigest=e.mandate.settingsDigest;
  manifest.carry[0].carry=carry;manifest.carry[0].revision=2;
  o.follower=history.snapshot;o.generationManifest=manifest;
  const fill=parseLiveSourceFill({tid:2,oid:8,time:e.now-50,coin:'BTC',side:'A',px:'100',sz:full?'4':'1',startPosition:'4'}, {network:'testnet',leaderAddress:e.mandate.leaderAddress,from:e.now-1000,to:e.now,receivedAt:e.now,kind:'fills'});
  (e as any).fill=fill;(e as any).leg=canonicalLiveSourceLegs(fill)[0];
  Object.assign(b,{sourceFillId:fill.id,sourceDigest:fill.sourceDigest,leg:'close',fixedTradeClaim:false,carry:{amount:carry,revision:2}});
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
});
