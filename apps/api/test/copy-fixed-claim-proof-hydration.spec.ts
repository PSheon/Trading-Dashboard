import {it,expect} from 'vitest';
import {example,harnessInput} from './copy-fixed-claim-proof-test-utils.js';
import {proofTools,validateFixedClaimRefusal} from './copy-fixed-claim-proof-test-utils.js';
import {hydrateFixedClaimEvidence} from '../../../scripts/copy-harness/fixed-claim-proof.mjs';
const sqlRow=(row:any)=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),typeof v==='number'&&['providerTime','receivedAt'].includes(k)?new Date(v).toISOString():v]));
it('hydrates real SQL snake names and timestamps without altering immutable nested proof or SDK receipts',()=>{
 const x=example(),e=x.generation.manifest.journals[0],entry=Object.fromEntries(Object.entries(e).map(([k,v])=>[k,sqlRow(v)]));
 delete entry.provenance.sizing_basis_digest;entry.provenance.sizing_basis={historical:'original'};
 const sql=JSON.stringify({authorizationBinding:Object.fromEntries(Object.entries(x.authorizationBinding).map(([k,v])=>[k,sqlRow(v)])),mandate:sqlRow(x.mandate),settings:x.settings,fill:sqlRow(x.fill),entries:[entry],receipts:x.generation.manifest.receipts.map(sqlRow),ledger:x.generation.manifest.ledger.map(sqlRow)});
 const before=JSON.stringify(x);
 const hydrated=hydrateFixedClaimEvidence(sql,{candidate:x.candidate,dispatches:harnessInput(x).dispatches,network:x.sdk.network,accountAddress:x.sdk.accountAddress,fills:x.sdk.fills,tools:proofTools,now:x.generation.now});
 expect(validateFixedClaimRefusal(hydrated)).not.toBeNull();expect(validateFixedClaimRefusal(hydrated)).toEqual(validateFixedClaimRefusal(x));expect(JSON.stringify(x)).toBe(before);
});
it('rejects missing/oversized SQL evidence instead of accepting unknown proof',()=>{
 expect(()=>hydrateFixedClaimEvidence('EVIDENCE_TOO_LARGE',{} as any)).toThrow();
 expect(()=>hydrateFixedClaimEvidence(' '.repeat(8*1024*1024+1),{} as any)).toThrow();
});
