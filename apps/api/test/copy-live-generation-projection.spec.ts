import { describe, expect, it } from 'vitest';
import { fixture } from './copy-live-risk-test-utils.js';
import { captureLivePositionBaseline } from '../src/copy/live/live-position-baseline.js';
import { compactLiveGenerationManifest, liveSettlementProofsOf, LiveGenerationProjectionMemo, projectLiveGenerationPositions, retainedSettlementProofRefs, type LiveGenerationProjectionInput, type LiveGenerationManifestV1 } from '../src/copy/live/copy-live-generation-projection.js';
import { freezeLiveReservation } from '../src/copy/live/live-risk-reservation.js';
import { settledGenerationExample } from './copy-live-generation-test-utils.js';
import { parseFollowerFunding, followerReceiptDigestV1 } from '../src/copy/live/actual-fill-accounting.js';
const key = `testnet:0x${'22'.repeat(20)}:0x${'ab'.repeat(16)}`;
function example(): LiveGenerationProjectionInput {
  const f=fixture(), snapshot=f.accountSource.snapshot;
  const identity={mandateId:'mandate',mandateRevision:2,accountId:'account',userId:1,strategyId:9,network:'testnet' as const,
    accountAddress:snapshot.accountAddress,authorizationId:'grant',settingsDigest:'b'.repeat(64),leaderAddress:`0x${'44'.repeat(20)}`,direction:'same' as const};
  const baseline=captureLivePositionBaseline({mandateId:identity.mandateId,accountId:identity.accountId,strategyId:identity.strategyId,network:'testnet',accountAddress:identity.accountAddress,firstExecutionKey:key},snapshot,f.now);
  const manifest:LiveGenerationManifestV1={version:1,accountId:'account',mandateId:'mandate',checkedAt:f.now,baseline,journals:[],receipts:[],ledger:[],scan:null,conflicts:[],accountState:null,carry:[]};
  return {identity,manifest,snapshot,currentExecutionKey:key,now:f.now};
}
describe('generation quantity projection requires actual immutable origin',()=>{
  it('accepts the original atomic empty baseline before its exact first prepared candidate',()=>{
    expect(projectLiveGenerationPositions(example())).toMatchObject({mandateId:'mandate',positions:{}});
  });
  it.each(['baseline','account','generation','key','expiry','quarantine','conflict','manual'])('refuses %s drift even when actual account positions are empty',kind=>{
    const e=structuredClone(example()),m=e.manifest as LiveGenerationManifestV1;
    if(kind==='baseline') (m.baseline.snapshot as {perpEquity:string}).perpEquity='1000';
    if(kind==='account') (m as {accountId:string}).accountId='foreign';
    if(kind==='generation') (e.identity as {mandateId:string}).mandateId='other';
    if(kind==='key') (e as {currentExecutionKey:string}).currentExecutionKey=key.replace('abab','cdcd');
    if(kind==='expiry') (e as {now:number}).now+=5001;
    if(kind==='quarantine') (m as unknown as {accountState:unknown}).accountState={accountId:'account',quarantined:true};
    if(kind==='conflict') (m as unknown as {conflicts:unknown[]}).conflicts=[{receiptKey:'manual'}];
    if(kind==='manual') (m as unknown as {receipts:unknown[]}).receipts=[{kind:'fill',attribution:'account',executionKey:null}];
    expect(()=>projectLiveGenerationPositions(e)).toThrow();
  });
  it('does not substitute an unproved actual account-only position for a generation receipt chain',()=>{
    const e=example(); (e.snapshot.positions as unknown[]).push({coin:'BTC',size:'1'});
    expect(()=>projectLiveGenerationPositions(e)).toThrow();
  });
  it('reconstructs genuine settled generation quantity from the original proof and current actual receipts',()=>{
    expect(projectLiveGenerationPositions(settledGenerationExample())).toMatchObject({positions:{BTC:'1'}});
  });
  it('accepts only the exact canonical first prepared candidate before a reservation has been held',()=>{
    const e=structuredClone(settledGenerationExample()),m=e.manifest as any,j=m.journals[0];
    (e as any).currentExecutionKey=j.journal.key;(e as any).snapshot=structuredClone(m.baseline.snapshot);
    j.journal.state='prepared';j.journal.record.state='prepared';j.leg.state='prepared';j.reservation=null;j.evidence=null;m.receipts=[];m.ledger=[];m.scan=null;
    expect(projectLiveGenerationPositions(e)).toMatchObject({positions:{}});
  });
  it.each(['valid','missing','successor','unknown','attempted'] as const)('requires original held lineage for own submitting candidate: %s',kind=>{
    const e=structuredClone(settledGenerationExample()),m=e.manifest as any,j=m.journals[0];
    (e as any).currentExecutionKey=j.journal.key;(e as any).snapshot=structuredClone(m.baseline.snapshot);
    j.journal.state='submitting';j.journal.record.state='submitting';j.leg.state='prepared';j.evidence=null;m.receipts=[];m.ledger=[];m.scan=null;
    Object.assign(j.reservation,{state:'held',revision:1,attemptedAt:null,exchangeOrderId:null,releaseEvidenceDigest:null});
    const held={payload:j.reservation.payload,state:'held',revision:1,attemptedAt:null,exchangeOrderId:null,releaseEvidenceDigest:null,updatedAt:Date.parse(j.reservation.updatedAt)};
    if(kind!=='missing')(e as any).ownSubmittingReservation=held;
    if(kind==='successor')held.revision=2;
    if(kind==='unknown')Object.assign(held,{state:'unknown'});
    if(kind==='attempted')Object.assign(held,{attemptedAt:e.now});
    if(kind==='valid')expect(projectLiveGenerationPositions(e)).toMatchObject({positions:{}});
    else expect(()=>projectLiveGenerationPositions(e)).toThrow();
  });
  it.each(['certificateOnly','proof','nonce','provenance','source','leg','receipt','fee','manualOtherCoin','scan','released','firstKey'])('rejects settled %s substitution',kind=>{
    const e=structuredClone(settledGenerationExample()),m=e.manifest as any,j=m.journals[0];
    if(kind==='certificateOnly')delete j.evidence.settlementProof;
    if(kind==='proof')j.evidence.settlementProof.input.accountSource.snapshot.perpEquity='1000';
    if(kind==='nonce')j.journal.nonce++;
    if(kind==='provenance')j.provenance.mandateId='prior-generation';
    if(kind==='source')j.fill.px='101';
    if(kind==='leg')j.leg.size='2';
    if(kind==='receipt')m.receipts[0].record.size='2';
    if(kind==='fee')m.ledger[0].amount='0';
    if(kind==='manualOtherCoin')m.receipts.push({...m.receipts[0],key:'manual',coin:'ETH',attribution:'account',executionKey:null});
    if(kind==='scan')m.scan.issue='gap';
    if(kind==='released')j.reservation.releaseEvidenceDigest='c'.repeat(64);
    if(kind==='firstKey')m.baseline.firstExecutionKey=e.currentExecutionKey;
    expect(()=>projectLiveGenerationPositions(e)).toThrow();
  });
  it.each(['0','-0.5'])('accepts actual signed funding %s using the existing sparse-zero ledger protocol',amount=>{
    const e=structuredClone(settledGenerationExample()),m=e.manifest as any,time=e.now-50,raw={hash:`0x${'cd'.repeat(32)}`,time,delta:{coin:'BTC',type:'funding',usdc:amount}},funding=parseFollowerFunding(raw,{network:'testnet',accountAddress:e.identity.accountAddress});
    m.receipts.push({key:funding.key,accountId:e.identity.accountId,network:'testnet',accountAddress:e.identity.accountAddress,kind:'funding',sourceId:funding.hash,coin:'BTC',providerTime:new Date(time).toISOString(),digest:followerReceiptDigestV1(raw),record:{...funding,raw},executionKey:null,attribution:'account',createdAt:new Date(e.now).toISOString()});
    if(amount!=='0')m.ledger.push({receiptKey:funding.key,component:'funding',amount,token:'USDC',createdAt:new Date(e.now).toISOString()});
    m.scan.through=time;
    Object.assign(e.snapshot,{completedAt:time+20});Object.assign(e.snapshot.dexes[0]!,{providerTime:time+10});Object.assign(e.snapshot.coverage,{earliestProviderTime:time+10});
    expect(projectLiveGenerationPositions(e)).toMatchObject({positions:{BTC:'1'}});
  });
  it('accepts a funding payment as Hyperliquid writes it: zero hash, szi, fundingRate, nSamples null (Stage mainnet 2026-10-12)',()=>{
    const e=structuredClone(settledGenerationExample()),m=e.manifest as any,time=e.now-50,
      raw={hash:`0x${'0'.repeat(64)}`,time,delta:{szi:'1',coin:'BTC',type:'funding',usdc:'0.000126',nSamples:null,fundingRate:'0.0000125'}},
      funding=parseFollowerFunding(raw,{network:'testnet',accountAddress:e.identity.accountAddress,coin:'BTC'});
    m.receipts.push({key:funding.key,accountId:e.identity.accountId,network:'testnet',accountAddress:e.identity.accountAddress,kind:'funding',sourceId:funding.hash,coin:'BTC',providerTime:new Date(time).toISOString(),digest:followerReceiptDigestV1(raw),record:{...funding,raw},executionKey:null,attribution:'account',createdAt:new Date(e.now).toISOString()});
    m.ledger.push({receiptKey:funding.key,component:'funding',amount:'0.000126',token:'USDC',createdAt:new Date(e.now).toISOString()});
    m.scan.through=time;
    Object.assign(e.snapshot,{completedAt:time+20});Object.assign(e.snapshot.dexes[0]!,{providerTime:time+10});Object.assign(e.snapshot.coverage,{earliestProviderTime:time+10});
    expect(projectLiveGenerationPositions(e)).toMatchObject({positions:{BTC:'1'}});
  });
  it('requires every current all-venue frame to follow the latest actual generation fill',()=>{
    const e=structuredClone(settledGenerationExample()),m=e.manifest as any,old=Date.parse(m.receipts[0].providerTime)-1;
    Object.assign(e.snapshot.dexes[0]!,{providerTime:old});Object.assign(e.snapshot.coverage,{earliestProviderTime:old});
    expect(()=>projectLiveGenerationPositions(e)).toThrow();
  });
});
describe('a retained manifest names settled proofs by digest (sizing envelopes, O1)',()=>{
  const settled=()=>{const e=settledGenerationExample(),m=e.manifest as LiveGenerationManifestV1;return {e,m,compact:compactLiveGenerationManifest(m),proofs:liveSettlementProofsOf(m)};};
  it('projects a compact manifest with its proofs by digest exactly as the inline one; an inline (older) manifest is unchanged',()=>{
    const {e,m,compact,proofs}=settled(),digest=m.journals[0]!.evidence!.settlementProofDigest!;
    expect(compact.journals[0]!.evidence).not.toHaveProperty('settlementProof');expect(compact.journals[0]!.evidence!.settlementProofDigest).toBe(digest);
    expect(Object.keys(proofs)).toEqual([digest]);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(m)));
    const inline=projectLiveGenerationPositions(e);
    expect(projectLiveGenerationPositions({...e,manifest:compact,settlementProofs:proofs})).toEqual(inline);
    // Proofs supplied for an inline manifest are never consulted.
    expect(projectLiveGenerationPositions({...e,settlementProofs:{}})).toEqual(inline);
    expect(retainedSettlementProofRefs(compact)).toEqual([{key:m.journals[0]!.journal.key,digest}]);expect(retainedSettlementProofRefs(m)).toEqual([]);
  });
  it.each(['missing','altered','other_digest','null_inline'] as const)('refuses a compact manifest whose proof is %s',kind=>{
    const {e,m,compact,proofs}=settled(),digest=m.journals[0]!.evidence!.settlementProofDigest!;
    let supplied:Record<string,unknown>=proofs,manifest:LiveGenerationManifestV1=compact;
    if(kind==='missing')supplied={};
    if(kind==='altered'){const p=structuredClone(proofs[digest]) as {certificate:{filledSize:string}};p.certificate.filledSize='2';supplied={[digest]:p};}
    if(kind==='other_digest')supplied={['f'.repeat(64)]:proofs[digest]};
    // A null proof column is not a retained reference: never filled from the map.
    if(kind==='null_inline')manifest={...m,journals:m.journals.map(j=>({...j,evidence:{...j.evidence!,settlementProof:null}}))};
    expect(()=>projectLiveGenerationPositions({...e,manifest,settlementProofs:supplied})).toThrow('live_generation_unproven');
  });
});
describe('one preparation projects its sizing envelope once (LiveGenerationProjectionMemo)',()=>{
  const prepared=()=>{
    const e=settledGenerationExample(),m=e.manifest as LiveGenerationManifestV1,compact=compactLiveGenerationManifest(m),proofs=freezeLiveReservation(liveSettlementProofsOf(m));
    const envelope=freezeLiveReservation(structuredClone({observations:{generationManifest:compact,follower:e.snapshot}}));
    // What the planner hands the projection: its own clone of the envelope, at its time.
    const at=(now:number,manifest:LiveGenerationManifestV1=compact,identity=e.identity):LiveGenerationProjectionInput=>({...e,identity,manifest:structuredClone(manifest),snapshot:structuredClone(e.snapshot),settlementProofs:structuredClone(proofs),now});
    return {e,compact,proofs,envelope,at};
  };
  it('a later check of the same frozen envelope and proofs reuses the projection, its time-dependent checks run again at the later time',()=>{
    const {e,proofs,envelope,at}=prepared(),memo=new LiveGenerationProjectionMemo();
    const first=memo.project(at(e.now),{envelope,proofs});
    expect(first).toEqual(projectLiveGenerationPositions(at(e.now)));expect(memo.reused).toBe(0);
    expect(memo.project(at(e.now+1000),{envelope,proofs})).toBe(first);expect(memo.reused).toBe(1);
    // The manifest was checked over 5 s before: refused, reused or not.
    expect(()=>memo.project(at(e.now+5001),{envelope,proofs})).toThrow('live_generation_unproven');
    expect(()=>projectLiveGenerationPositions(at(e.now+5001))).toThrow('live_generation_unproven');
    expect(memo.reused).toBe(1);
  });
  it('anything not provably the same is projected in full, and a manifest that differs from the reused one is refused',()=>{
    const {e,compact,proofs,envelope,at}=prepared(),memo=new LiveGenerationProjectionMemo(),first=memo.project(at(e.now+1000),{envelope,proofs});
    // An earlier time than the reused projection's, another (equal) envelope object, an unfrozen one, other proofs, another identity.
    for(const [input,source] of [[at(e.now+500),{envelope,proofs}],[at(e.now+1000),{envelope:freezeLiveReservation(structuredClone(envelope)),proofs}],
      [at(e.now+1000),{envelope:structuredClone(envelope),proofs}],[at(e.now+1000),{envelope,proofs:freezeLiveReservation(structuredClone(proofs))}],
      [at(e.now+1000,compact,{...e.identity,mandateRevision:3}),{envelope,proofs}]] as const){
      const projection=memo.project(input,source);expect(projection).not.toBe(first);expect(projection).toEqual(first);
    }
    expect(memo.reused).toBe(0);
    // Same envelope and proofs objects, but the manifest handed over is not theirs (its carry, a journal, a receipt changed): refused.
    const fresh=new LiveGenerationProjectionMemo(),reference=fresh.project(at(e.now),{envelope,proofs});
    const carry={...compact,carry:compact.carry.map(row=>({...row,revision:row.revision+1}))};
    const journal={...compact,journals:compact.journals.map(j=>({...j,journal:{...j.journal,cloid:`0x${'ee'.repeat(16)}`}}))};
    const receipt={...compact,receipts:compact.receipts.map(r=>({...r,createdAt:new Date(e.now-1).toISOString()}))};
    for(const manifest of [carry,journal,receipt])expect(()=>fresh.project(at(e.now+10,manifest),{envelope,proofs})).toThrow('live_generation_unproven');
    expect(fresh.project(at(e.now+20),{envelope,proofs})).toBe(reference);
  });
});
