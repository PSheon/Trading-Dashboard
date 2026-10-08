import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compiledProofFiles,verifyProofArtifacts,loadProofRuntime,PROOF_MODULES } from './proof-runtime.mjs';
import {createFixedClaimValidator,fixedClaimEvidenceQuery} from './fixed-claim-proof.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'proof-runtime-test-'))),put=(path,value)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),value);};
 for(const path of [...PROOF_MODULES,'apps/api/dist/main.js','packages/shared/dist/contracts.js'])put(path,'export {};');
 mkdirSync(join(root,'apps/api/node_modules/@trading-dashboard'),{recursive:true});symlinkSync(join(root,'packages/shared'),join(root,'apps/api/node_modules/@trading-dashboard/shared'));
 const build={commit:'a'.repeat(40),trackedBlobs:1,allTrackedBlobsUnchanged:true,status:'passed',envCopied:false,mainSha256:sha('export {};')};
 put('BUILD-EVIDENCE.json',JSON.stringify(build));
 const manifest={version:1,reviewed:true,root,commit:build.commit,buildSha256:sha(JSON.stringify(build)),files:compiledProofFiles(root)};
 return {root,build,manifest,put,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('accepts only root-reviewed build and exact complete compiled hash set',()=>{const f=fixture();try{assert.equal(verifyProofArtifacts(f.root,f.manifest,f.build).length,9);}finally{f.close();}});
for(const [name,change]of Object.entries({
 'unreviewed artifact':f=>f.manifest.reviewed=false,
 'different commit':f=>f.manifest.commit='b'.repeat(40),
 'changed decoder compiled file':f=>f.put(PROOF_MODULES[0],'export const corrupt=true;'),
 'changed transitive shared compiled file':f=>f.put('packages/shared/dist/contracts.js','export const corrupt=true;'),
 'missing compiled hash':f=>f.manifest.files.pop(),
 'failed build evidence':f=>f.build.status='failed',
 'changed source attestation':f=>f.build.allTrackedBlobsUnchanged=false,
 'foreign runtime root':f=>f.manifest.root='/private/tmp/foreign',
}))test(`rejects ${name}`,()=>{const f=fixture();try{change(f);assert.throws(()=>verifyProofArtifacts(f.root,f.manifest,f.build));}finally{f.close();}});
test('rejects implicit or non-profile runtime before any provider or database operation',async()=>{await assert.rejects(loadProofRuntime({}),/exact local testnet/);await assert.rejects(loadProofRuntime({profile:'stage-caps',network:'mainnet',leaderNetwork:'testnet',db:'env'}),/exact local testnet/);});
test('factory rejects boolean or missing decoder injection',()=>{assert.throws(()=>createFixedClaimValidator(true));assert.throws(()=>createFixedClaimValidator({}));});
test('evidence query refuses unrelated reasons and non-testnet/current owner',()=>{const d={id:'x',mandateId:'m',userId:14,state:'refused',leg:'open',reason:'signal_expired'};assert.equal(fixedClaimEvidenceQuery(d,{network:'testnet',leaderNetwork:'testnet'}),null);d.reason='fixed_trade_already_claimed';assert.equal(fixedClaimEvidenceQuery({...d,userId:2},{network:'testnet',leaderNetwork:'testnet'}),null);});

test('every qualified evidence SQL column exists in the actual shared schema',async()=>{
 const {readFileSync}=await import('node:fs');
 const schema=readFileSync(new URL('../../packages/shared/src/schema/db.ts',import.meta.url),'utf8');
 const columns=table=>{
  const escaped=table.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const body=new RegExp(`pgTable\\("${escaped}", \\{([\\s\\S]*?)\\n\\},`).exec(schema)?.[1];
  assert.ok(body,`table ${table}`);return new Set([...body.matchAll(/(?:text|integer|serial|bigserial|bigint|timestamp|jsonb|numeric|boolean)\("([a-z_]+)"/g)].map(m=>m[1]));
 };
 const bindings={d:'copy_live_dispatches',m:'copy_live_mandates',v:'copy_strategy_versions',f:'copy_live_source_fills',a:'copy_execution_accounts',u:'users',l:'copy_live_signal_legs',j:'copy_live_executions',p:'copy_live_intent_provenance',s:'copy_live_source_fills',r:'copy_live_risk_reservations',e:'copy_live_execution_evidence',c:'copy_follower_receipts'};
 const sql=fixedClaimEvidenceQuery({id:'d',mandateId:'m',sourceFillId:'f',userId:14,state:'refused',reason:'fixed_trade_already_claimed',leg:'open'},{network:'testnet',leaderNetwork:'testnet',leader:`0x${'11'.repeat(20)}`,follower:`0x${'22'.repeat(20)}`});
 for(const [alias,table]of Object.entries(bindings))for(const match of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)\\b`,'g')))assert.ok(columns(table).has(match[1]),`${alias}.${match[1]} not in ${table}`);
});
