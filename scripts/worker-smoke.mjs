import { workerMonitorSchema } from "../packages/shared/dist/contracts.js";
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json',import.meta.url));
const {Pool}=require('pg');
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, openSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const logDir=mkdtempSync(resolve(tmpdir(),'orbie-worker-smoke-'));
const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw Error('TEST_DATABASE_URL required');
const target=new URL(databaseUrl);
if(!['postgres:','postgresql:'].includes(target.protocol)||!['localhost','127.0.0.1','[::1]'].includes(target.hostname)||!/^\/[a-zA-Z0-9_]+_test$/.test(target.pathname)||target.search||target.hash)throw Error('Use a loopback *_test database without URL options');
const children=[];
const env={PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:databaseUrl,TELEGRAM_BOT_POLLING:'false'};
// WORKER_SMOKE_DIST: a throwaway build directory instead of apps/api/dist.
const entry=(process.env.WORKER_SMOKE_DIST??'dist')+'/main.js';
// `extra`: more environment. Every process records its Hyperliquid requests
// (worker-smoke-egress.mjs) in <logDir>/<port>-egress.log.
const egressLog=port=>logDir+'/'+port+'-egress.log';
const launch=(port,worker,extra={})=>{const child=spawn(process.execPath,['--import',root+'/scripts/worker-smoke-egress.mjs',entry],{cwd:root+'/apps/api',env:{...env,...(worker?{IS_WORKER:'true'}:{}),PORT:String(port),WORKER_URL:'http://127.0.0.1:3311',WORKER_SMOKE_EGRESS_LOG:egressLog(port),...extra},stdio:['ignore',openSync(logDir+'/'+port+'.log','w'),openSync(logDir+'/'+port+'-err.log','w')]}); children.push(child);return child;};
const egress=port=>existsSync(egressLog(port))?readFileSync(egressLog(port),'utf8').split('\n').filter(Boolean):[];
const monitorOf=async port=>workerMonitorSchema.parse(await (await probe(port,'/health/monitor')).json());
// A stand-in for Hyperliquid's info API on loopback, for the role hand-off.
// With an egress key (the shared meter requires one) an active worker reads
// the market catalog on start (MarketCatalogService: perpDexs, then meta);
// worker-smoke-egress.mjs records each Hyperliquid request and answers it
// from here (WORKER_SMOKE_HL_STUB), so nothing leaves the host. "No request
// from a standby" is then measured against processes that do make requests
// once they hold their lease.
const HL_STUB_PORT=3330;
const hlEnv={HYPERLIQUID_EGRESS_KEY:'worker-smoke',WORKER_SMOKE_HL_STUB:`http://127.0.0.1:${HL_STUB_PORT}`};
const hlServer=createServer((req,res)=>{let body='';req.on('data',c=>{body+=c;});req.on('end',()=>{let type;try{type=JSON.parse(body).type;}catch{}
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify(type==='perpDexs'?[null]:type==='meta'?{universe:[{name:'BTC',szDecimals:5,maxLeverage:40}]}:[]));});});
hlServer.on('upgrade',(_req,socket)=>socket.destroy());
// The first active monitor sample reads the discovery pool's freshness, which can wait
// up to 2 s for the market catalog on a cold start.
// /health/monitor answers only the api's key (apps/api/src/runtime/worker-calls.ts).
const monitorKey=createHmac('sha256',databaseUrl).update('orbie:worker-monitor:v1').digest('hex');
async function probe(port,path){const monitor=path==='/health/monitor';return fetch(`http://127.0.0.1:${port}${path}`,{headers:monitor?{Authorization:`Bearer ${monitorKey}`}:{},signal:AbortSignal.timeout(monitor?5000:1000)});}
async function until(port,path,status){for(let i=0;i<100;i++){try{if((await probe(port,path)).status===status)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error(`${port}${path} not ${status}`);}
async function stop(c){if(c.exitCode!==null || c.signalCode!==null)return;await new Promise(r=>{c.once('exit',r);c.kill('SIGTERM');});}
await new Promise((r,j)=>{hlServer.once('error',j);hlServer.listen(HL_STUB_PORT,'127.0.0.1',r);});
/** Waits until `port`'s worker has made a Hyperliquid request at or after `since`. */
async function requestedSince(port,since){for(let i=0;i<100;i++){if(egress(port).some(line=>Number(line.split(' ')[0])>=since))return;await new Promise(r=>setTimeout(r,100));}throw Error(`${port} made no Hyperliquid request once active`);}
try {
 const a=launch(3311,true);await until(3311,'/health/ready',200);
 const b=launch(3312,true);await until(3312,'/health/live',200);
 const activeMonitor=workerMonitorSchema.parse(await (await probe(3311,'/health/monitor')).json());
 const standbyMonitor=workerMonitorSchema.parse(await (await probe(3312,'/health/monitor')).json());
 if(activeMonitor.state!=='active'||!activeMonitor.budget||!activeMonitor.heartbeat)throw Error('active telemetry missing');
 if(standbyMonitor.state!=='standby'||standbyMonitor.budget!==null||standbyMonitor.heartbeat!==null)throw Error('standby reports active telemetry');
 if(activeMonitor.instanceId===standbyMonitor.instanceId)throw Error('worker identities collide');
 if((await probe(3312,'/health/ready')).status!==503)throw Error('second worker acquired lock');
 if((await probe(3311,'/me')).status!==404)throw Error('worker exposes API');
 if((await fetch('http://127.0.0.1:3311/health/monitor',{signal:AbortSignal.timeout(5000)})).status!==404)throw Error('worker telemetry readable without the key');
 const api=launch(3313,false);await until(3313,'/health/ready',200);await until(3313,'/health',200);
 await stop(api);await until(3311,'/health/ready',200);
 await stop(a);await until(3312,'/health/ready',200);
 const c=launch(3314,true);await until(3314,'/health/live',200);
 const pool=new Pool({connectionString:env.DATABASE_URL});
 try {await pool.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=73106 AND objid=1 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");} finally{await pool.end();}
 await until(3314,'/health/ready',200);
 if(b.exitCode!==1)throw Error('lost ownership did not fail-stop');
 // WORKER_ROLE: an `all` worker (unset, both leases) hands off to a `copy`
 // and a `read` worker, which wait on standby without a Hyperliquid call.
 await stop(c);
 const allStartedAt=Date.now(),all=launch(3321,true,hlEnv);await until(3321,'/health/ready',200);
 // The active worker does reach (the stand-in for) Hyperliquid: the standbys' silence below means something.
 await requestedSince(3321,allStartedAt);
 const allBeat=(await monitorOf(3321)).heartbeat?.worker;
 if(allBeat?.role!=='all'||allBeat.leases.join()!=='1,2')throw Error(`all worker reports ${JSON.stringify(allBeat)}`);
 launch(3322,true,{...hlEnv,WORKER_ROLE:'copy'});launch(3323,true,{...hlEnv,WORKER_ROLE:'read'});
 await until(3322,'/health/live',200);await until(3323,'/health/live',200);
 // Three lease polls on standby: neither takes over, neither reaches Hyperliquid.
 await new Promise(r=>setTimeout(r,3000));
 for(const port of [3322,3323]){if((await probe(port,'/health/ready')).status!==503)throw Error(`${port} took over from the all worker`);const m=await monitorOf(port);if(m.state!=='standby'||m.heartbeat!==null)throw Error(`${port} is not on standby`);}
 const standbyEgress=[...egress(3322),...egress(3323)];
 if(standbyEgress.length)throw Error(`a standby worker called Hyperliquid: ${standbyEgress.join(', ')}`);
 const handoffAt=Date.now();await stop(all);
 await until(3322,'/health/ready',200);await until(3323,'/health/ready',200);
 for(const [port,role,leases] of [[3322,'copy','1'],[3323,'read','2']]){const beat=(await monitorOf(port)).heartbeat?.worker;if(beat?.role!==role||beat.leases.join()!==leases)throw Error(`${port} reports ${JSON.stringify(beat)}`);}
 // Whatever reached Hyperliquid (worker-smoke-egress.mjs) did so only after the hand-off.
 const early=[...egress(3322),...egress(3323)].filter(line=>Number(line.split(' ')[0])<handoffAt);
 if(early.length)throw Error(`Hyperliquid called before the lease: ${early.join(', ')}`);
 // …and each did once it held its lease.
 await requestedSince(3322,handoffAt);await requestedSince(3323,handoffAt);
 console.log('Hyperliquid requests: all',egress(3321).length,'copy',egress(3322).length,'read',egress(3323).length);
 console.log('Smoke logs:',logDir);
 console.log(JSON.stringify({ownershipLossFailStop:true,workerReady:true,standbyExcluded:true,noBusinessRoutes:true,apiStopDoesNotStopWorker:true,handoffPassed:true,roleHandoffPassed:true,activeMadeHyperliquidCall:true,standbyMadeNoHyperliquidCall:true}));
}finally{for(const c of children)await stop(c);hlServer.close();}
