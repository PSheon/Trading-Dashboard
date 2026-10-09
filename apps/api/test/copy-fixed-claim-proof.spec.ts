import { describe,it,expect } from 'vitest';
import { example } from './copy-fixed-claim-proof-test-utils.js';
import { validateFixedClaimRefusal } from './copy-fixed-claim-proof-test-utils.js';
import { parseLiveSourceFill } from '../src/copy/live/copy-live-source-evidence.js';
describe('private fixed-claim refusal certificate',()=>{
 it('accepts only the original released and verified execution with real matching SDK fill',()=>{const x=example();expect(validateFixedClaimRefusal(x)).toEqual({originalExecutionKey:x.generation.manifest.journals[0].journal.key,originalLegId:x.generation.manifest.journals[0].leg!.id,tradeKey:x.fill.tradeKey});});
 it('accepts same original TWAP across different provider order ids',()=>expect(validateFixedClaimRefusal(example(9))?.tradeKey).toBe('twap:9'));
 it('rejects a different TWAP even when provider order id is reused',()=>{const x=example(9);const raw={...x.fill.raw,twapId:10};x.fill=parseLiveSourceFill(raw,{network:'testnet',leaderAddress:x.mandate.leaderAddress,from:x.fill.providerTime,to:x.fill.providerTime,receivedAt:x.fill.receivedAt,kind:'fills'});expect(validateFixedClaimRefusal(x)).toBeNull();});
 it('verifies historical evidence without changing original timestamps or granting current authority',()=>{const x=example();x.generation.now+=86400000;const before=structuredClone(x);expect(validateFixedClaimRefusal(x)).not.toBeNull();expect(x).toEqual(before);});
 for(const [name,mutate] of Object.entries({
  'missing original dispatch from report':(x:any):unknown=>x.originalDispatch=null,
  'unsettled original dispatch':(x:any):unknown=>x.originalDispatch.state='submitted',
  'different original dispatch source':(x:any):unknown=>x.originalDispatch.sourceFillId='foreign-source',
  'different original dispatch generation':(x:any):unknown=>x.originalDispatch.mandateId='older-mandate',
  'foreign original dispatch owner':(x:any):unknown=>x.originalDispatch.userId=2,
  'foreign original grant owner DID':(x:any):unknown=>x.generation.manifest.journals[0].journal.record.authorization.privyOwnerId='foreign',
  'wrong original grant version':(x:any):unknown=>x.generation.manifest.journals[0].journal.record.authorization.version=99,
  'wrong original agent identity':(x:any):unknown=>x.generation.manifest.journals[0].journal.record.authorization.signerAddress=`0x${'99'.repeat(20)}`,
  'wrong original tradeKey':(x:any):unknown=>x.generation.manifest.journals[0].leg.tradeKey='oid:999',
  'wrong original source digest':(x:any):unknown=>x.generation.manifest.journals[0].provenance.sourceDigest='0'.repeat(64),
  'wrong original settings digest':(x:any):unknown=>x.generation.manifest.journals[0].provenance.settingsDigest='0'.repeat(64),
  'wrong original fingerprint':(x:any):unknown=>x.generation.manifest.journals[0].journal.record.fingerprint='0'.repeat(64),
  'wrong original reservation owner':(x:any):unknown=>x.generation.manifest.journals[0].reservation.userId=2,
  'wrong original certificate account':(x:any):unknown=>x.generation.manifest.journals[0].evidence.settlementProof.certificate.accountId='foreign',
  'wrong original booked receipt digest':(x:any):unknown=>x.generation.manifest.receipts[0].digest='0'.repeat(64),
  'missing original booked receipt':(x:any):unknown=>x.generation.manifest.receipts=[],
  'wrong original booked fee ledger':(x:any):unknown=>x.generation.manifest.ledger[0].amount='-99',
  'wrong original release reason':(x:any):unknown=>x.generation.manifest.journals[0].reservation.releaseReason='expired_unplaced',
  'wrong original status mirror':(x:any):unknown=>x.generation.manifest.journals[0].evidence.statusDigest='0'.repeat(64),
  'foreign canonical current source':(x:any):unknown=>x.fill.leaderAddress=`0x${'99'.repeat(20)}`,
  'future canonical current source':(x:any):unknown=>x.fill.providerTime+=1000,
  'malformed original source':(x:any):unknown=>x.generation.manifest.journals[0].fill.raw=null,
  'missing actual SDK fill':(x:any):unknown=>x.sdk.fills=[],
  'SDK foreign account':(x:any):unknown=>x.sdk.accountAddress=`0x${'99'.repeat(20)}`,
  'SDK foreign network':(x:any):unknown=>x.sdk.network='mainnet',
  'SDK wrong cloid':(x:any):unknown=>x.sdk.fills[0].cloid=`0x${'99'.repeat(16)}`,
  'SDK wrong oid':(x:any):unknown=>x.sdk.fills[0].oid=11,
  'SDK extra unbooked fill':(x:any):unknown=>x.sdk.fills.push({...x.sdk.fills[0],tid:999}),
  'SDK duplicated receipt':(x:any):unknown=>x.sdk.fills.push({...x.sdk.fills[0]}),
  'SDK missing cloid':(x:any):unknown=>delete x.sdk.fills[0].cloid,
  'SDK corrupted amount':(x:any):unknown=>x.sdk.fills[0].sz='9',
  'prepared original':(x:any):unknown=>x.generation.manifest.journals[0].journal.state='prepared',
  'unknown original':(x:any):unknown=>x.generation.manifest.journals[0].journal.state='unknown',
  'rejected original':(x:any):unknown=>x.generation.manifest.journals[0].journal.state='rejected',
  'held reservation':(x:any):unknown=>x.generation.manifest.journals[0].reservation.state='held',
  'missing settlement proof':(x:any):unknown=>x.generation.manifest.journals[0].evidence.settlementProof=null,
  'corrupt settlement proof':(x:any):unknown=>x.generation.manifest.journals[0].evidence.settlementProof.certificate.oid='999',
  'different current generation':(x:any):unknown=>x.candidate.mandateId='later-mandate',
  'foreign current owner':(x:any):unknown=>x.candidate.userId=2,
  'wrong trade oid':(x:any):unknown=>x.fill.tradeKey='order:999',
  'missing current original source':(x:any):unknown=>x.fill=null,
  'current cutoff later than original':(x:any):unknown=>x.mandate.activationCursor=new Date(x.fill.providerTime+1),
  'different settings':(x:any):unknown=>x.settings.perTradeUsd=10,
  'other reason':(x:any):unknown=>x.candidate.reason='signal_expired',
  'fake claim without leg':(x:any):unknown=>x.generation.manifest.journals[0].leg=null,
  'released no verified certificate':(x:any):unknown=>x.generation.manifest.journals[0].reservation.releaseEvidenceDigest=null,
  'foreign original journal':(x:any):unknown=>x.generation.manifest.journals[0].journal.accountAddress=`0x${'99'.repeat(20)}`,
  'old generation original':(x:any):unknown=>x.generation.manifest.journals[0].leg.mandateId='older-mandate',
  'same source rather than later partial':(x:any):unknown=>x.candidate.sourceFillId=x.generation.manifest.journals[0].fill.id,
 }))it(`rejects ${name}`,()=>{const x=example();mutate(x);expect(validateFixedClaimRefusal(x)).toBeNull();});
});
