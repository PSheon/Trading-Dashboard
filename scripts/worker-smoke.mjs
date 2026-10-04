import { workerMonitorSchema } from "../packages/shared/dist/contracts.js";
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json',import.meta.url));
const {Pool}=require('pg');
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { openSync, mkdtempSync } from 'node:fs';
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
const launch=(port,worker)=>{const child=spawn(process.execPath,[entry],{cwd:root+'/apps/api',env:{...env,...(worker?{IS_WORKER:'true'}:{}),PORT:String(port),WORKER_URL:'http://127.0.0.1:3311'},stdio:['ignore',openSync(logDir+'/'+port+'.log','w'),openSync(logDir+'/'+port+'-err.log','w')]}); children.push(child);return child;};
// The first active monitor sample reads the discovery pool's freshness, which can wait
// up to 2 s for the market catalog on a cold start.
// /health/monitor answers only the api's key (apps/api/src/runtime/worker-calls.ts).
const monitorKey=createHmac('sha256',databaseUrl).update('orbie:worker-monitor:v1').digest('hex');
async function probe(port,path){const monitor=path==='/health/monitor';return fetch(`http://127.0.0.1:${port}${path}`,{headers:monitor?{Authorization:`Bearer ${monitorKey}`}:{},signal:AbortSignal.timeout(monitor?5000:1000)});}
async function until(port,path,status){for(let i=0;i<100;i++){try{if((await probe(port,path)).status===status)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error(`${port}${path} not ${status}`);}
async function stop(c){if(c.exitCode!==null || c.signalCode!==null)return;await new Promise(r=>{c.once('exit',r);c.kill('SIGTERM');});}
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
 console.log('Smoke logs:',logDir);
 console.log(JSON.stringify({ownershipLossFailStop:true,workerReady:true,standbyExcluded:true,noBusinessRoutes:true,apiStopDoesNotStopWorker:true,handoffPassed:true}));
}finally{for(const c of children)await stop(c);}
