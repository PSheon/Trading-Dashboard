import WebSocket from 'ws';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {HyperliquidGlobalTransport} from '../hyperliquid/hyperliquid-global-transport.js';
import {quotaSubscription} from '../hyperliquid/hyperliquid-global-quota.js';
import {validateInfoResponse} from '../hyperliquid/response-validation.js';
import type {HlTwapHistoryEntry} from '../hyperliquid/types.js';
import type {HyperliquidSocketQuota} from '../hyperliquid/postgres-hyperliquid-quota.js';
import type {LiveNetwork} from '../copy/live/wallet-authorization.js';

const MAX_BYTES=8*1024*1024;
const fail=():never=>{throw new Error('invalid_twap_snapshot');};
function owner(user:string){if(typeof user!=='string'||!/^0x[0-9a-f]{40}$/.test(user))fail();return user;}
export interface TraderTwapSnapshot {
 history:HlTwapHistoryEntry[];
 /** Original receipt clock; never advanced after cleanup or cache hits. */
 readonly observedAt:number;
 /** Latest source event time, NOT freshness of the subscription or cache. */
 sourceTime:number|null;
 /** Provider-retained snapshot only; never a claim of complete lifetime history. */
 coverage:'provider_snapshot';
}
/** Official userTwapHistory WS schema and installed SDK UserTwapHistoryEvent.
 * All retained entries are validated; never truncate or synthesize empty data. */
export function parseTwapSnapshot(value:unknown,user:string,observedAt=Date.now()):TraderTwapSnapshot {
 owner(user);if(!Number.isSafeInteger(observedAt)||observedAt<=0)fail();
 if(!value||typeof value!=='object')return fail();
 const envelope=value as {channel?:unknown;data?:{user?:unknown;isSnapshot?:unknown;history?:unknown}};
 if(envelope.channel!=='userTwapHistory'||envelope.data?.user!==user||envelope.data.isSnapshot!==true)return fail();
 const history=validateInfoResponse('twapHistory',envelope.data.history) as HlTwapHistoryEntry[];
 let sourceTime:number|null=null;
 for(const entry of history){
  const time=entry.time*1000;
  if(!Number.isSafeInteger(time))return fail();
  sourceTime=Math.max(sourceTime??0,time,entry.state.timestamp);
 }
 return {history,sourceTime,observedAt,coverage:'provider_snapshot'};
}
function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((ok,bad)=>{resolve=ok;reject=bad;});
 void promise.catch(()=>{});return {promise,resolve,reject};
}
async function bounded<T>(promise:Promise<T>,until:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('twap_snapshot_timeout')),Math.max(0,until-Date.now()));})]);}
 finally{clearTimeout(timer);}
}
type Session={socket:WebSocket;connection:HyperliquidSocketQuota;timer?:ReturnType<typeof setInterval>;heartbeat:boolean;awaitingPong:boolean;aborted:boolean;};
/** Read-only snapshots over one reused fixed-network socket. Concrete
 * global quota owns attach/ACK/close accounting; no REST or empty fallback. */
export class TraderTwapReader {
 private session?:Session;
 private stopping=false;
 private pending=0;
 private tail:Promise<void>=Promise.resolve();
 private readonly timeoutMs:number;
 private readonly cleanupTimeoutMs:number;
 constructor(private readonly transport:HyperliquidGlobalTransport,private readonly network:LiveNetwork='mainnet',options:{timeoutMs?:number;cleanupTimeoutMs?:number;infoUrl?:string}={}){
  if(!(transport instanceof HyperliquidGlobalTransport)||!['mainnet','testnet'].includes(network))fail();
  if(options.infoUrl!==undefined&&options.infoUrl!==`https://api.hyperliquid${network==='testnet'?'-testnet':''}.xyz/info`)fail();
  this.timeoutMs=options.timeoutMs??4000;this.cleanupTimeoutMs=options.cleanupTimeoutMs??2000;
  if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>4000||!Number.isSafeInteger(this.cleanupTimeoutMs)||this.cleanupTimeoutMs<1||this.cleanupTimeoutMs>2000)fail();
 }
 private async cancelUnsent(connection:HyperliquidSocketQuota){
  try{await bounded(connection.cancelBeforeConnect(),Date.now()+this.cleanupTimeoutMs);}
  catch{await bounded(connection.uncertain(),Date.now()+this.cleanupTimeoutMs).catch(()=>{});}
 }
 private abort(session:Session){
  if(session.aborted)return;session.aborted=true;
  if(this.session===session)this.session=undefined;
  clearInterval(session.timer);session.socket.terminate();
  void session.connection.uncertain().catch(()=>{});
 }
 private heartbeat(session:Session){
  session.timer=setInterval(()=>{
   if(this.session!==session||this.stopping||this.pending||session.heartbeat)return;
   if(session.awaitingPong){this.abort(session);return;}
   session.heartbeat=true;
   const until=Date.now()+5000;
   void (async()=>{
    await bounded(session.connection.renew(until),until);
    const permit=await bounded(session.connection.ping(until),until);
    if(this.session!==session||this.stopping)throw Error('twap_socket_lost');
    session.awaitingPong=true;
    permit.dispatch(()=>session.socket.send(JSON.stringify({method:'ping'})));
   })().catch(()=>this.abort(session)).finally(()=>{session.heartbeat=false;});
  },20000);session.timer.unref();
 }
 async onModuleDestroy():Promise<void>{
  this.stopping=true;clearInterval(this.session?.timer);
  try{
   await bounded(this.tail,Date.now()+this.cleanupTimeoutMs);
   const session=this.session;if(!session)return;
   await bounded(session.connection.close(Date.now()+this.cleanupTimeoutMs),Date.now()+this.cleanupTimeoutMs);
   await bounded(session.connection.whenIdle(),Date.now()+this.cleanupTimeoutMs);
   if(this.session===session)this.session=undefined;
  }catch(error){if(this.session)this.abort(this.session);throw error;}
 }
 async read(address:string):Promise<TraderTwapSnapshot>{
  owner(address);if(this.stopping||this.pending>=8||this.transport.isOriginal())fail();
  const until=Date.now()+this.timeoutMs,previous=this.tail,release=deferred<void>();
  this.tail=previous.then(()=>release.promise);this.pending++;
  try{await bounded(previous,until);if(this.stopping)fail();return await this.readSnapshot(address,until);}
  finally{this.pending--;release.resolve();}
 }
 private async readSnapshot(address:string,until:number):Promise<TraderTwapSnapshot>{
  const user=owner(address),subscription=quotaSubscription(this.network,{type:'userTwapHistory',user});
  const startedAt=Date.now(),startedMono=performance.now();
  const assertClock=()=>{
   const wall=Date.now(),elapsed=performance.now()-startedMono;
   if(!Number.isSafeInteger(wall)||wall<startedAt||!Number.isFinite(elapsed)||elapsed<0||elapsed>this.timeoutMs+this.cleanupTimeoutMs||Math.abs(wall-startedAt-elapsed)>1000)fail();
  };
  const wait=<T>(promise:Promise<T>,deadline:number)=>{
   assertClock();
   const remaining=this.timeoutMs+this.cleanupTimeoutMs-(performance.now()-startedMono);
   return bounded(promise,Math.min(deadline,Date.now()+Math.max(0,remaining)));
  };
  let session=this.session;
  let reserved:Awaited<ReturnType<ReturnType<HyperliquidGlobalTransport['currentQuota']>['reserveSocket']>>|undefined;
  if(session){try{await wait(session.connection.renew(until),until);}catch(error){this.abort(session);throw error;}}
  else{
   const reservation=this.transport.currentQuota().reserveSocket(until,this.network);let expired=false;
   void reservation.then(value=>{if(expired)void this.cancelUnsent(value.connection);},()=>{});
   try{reserved=await wait(reservation,until);}catch(error){expired=true;throw error;}
  }
  const connection=session?.connection??reserved!.connection;
  let socket=session?.socket,bytes=0,subscribed=false,unsubscribeRequested=false,cleaned=false;
  const opened=deferred<void>(),ack=deferred<void>(),snapshot=deferred<TraderTwapSnapshot>(),unsubscribed=deferred<void>();
  const reject=(error:unknown)=>{opened.reject(error);ack.reject(error);snapshot.reject(error);unsubscribed.reject(error);};
  try{
   if(this.stopping)fail();
   if(!session){
    socket=reserved!.connect.dispatch(()=>new WebSocket(`wss://api.hyperliquid${this.network==='testnet'?'-testnet':''}.xyz/ws`,{maxPayload:MAX_BYTES,followRedirects:false,autoPong:false,perMessageDeflate:false,handshakeTimeout:this.timeoutMs}));
    // Guard async ws errors even if concrete quota attachment rejects.
    socket.on('error',()=>{});
    connection.attach(socket);session={socket,connection,heartbeat:false,awaitingPong:false,aborted:false};this.session=session;
    const current=session;
    socket.on('error',()=>this.abort(current));
    socket.on('ping',()=>this.abort(current));
    socket.on('close',()=>{if(this.session===current)this.session=undefined;clearInterval(current.timer);});
    socket.on('message',(raw:WebSocket.RawData)=>{
     try{const payload=JSON.parse(String(raw));if(payload?.channel==='pong'){if(!current.awaitingPong)throw Error();current.awaitingPong=false;}else if(!this.pending)throw Error();}catch{this.abort(current);}
    });
    this.heartbeat(current);
   }
   socket=session.socket;
   const onOpen=()=>opened.resolve();socket.on('open',onOpen);
   if(socket.readyState===WebSocket.OPEN)opened.resolve();
   socket.on('error',reject);
   // Session heartbeat traffic is explicitly metered; automatic pongs stay disabled.
   const onClose=()=>{if(!cleaned)reject(new Error('twap_snapshot_closed'));};socket.on('close',onClose);
   const onMessage=(raw:WebSocket.RawData,isBinary:boolean)=>{
    try{
     assertClock();const receivedAt=Date.now();
     if(isBinary)fail();
     const buffer=Array.isArray(raw)?Buffer.concat(raw):raw instanceof ArrayBuffer?Buffer.from(raw):raw;
     bytes+=buffer.byteLength;if(bytes>MAX_BYTES)fail();
     const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
     if(value?.channel==='pong')return;
     if(value?.channel==='subscriptionResponse'){
      if(!isDeepStrictEqual(value.data?.subscription,subscription.subscription))fail();
      if(value.data.method==='subscribe'){if(!subscribed)fail();ack.resolve();}
      else if(value.data.method==='unsubscribe'){if(!unsubscribeRequested)fail();unsubscribed.resolve();}else fail();
     }else if(value?.channel==='userTwapHistory'){
      if(!subscribed)fail();snapshot.resolve(parseTwapSnapshot(value,user,receivedAt));
     }else fail();
    }catch(error){reject(error);}
   };socket.on('message',onMessage);
   const detach=()=>{socket!.off('open',onOpen);socket!.off('error',reject);socket!.off('message',onMessage);socket!.off('close',onClose);};
   try{
   await wait(opened.promise,until);
   const permit=await wait(connection.subscribe([subscription],until,true,false),until);
   subscribed=true;
   permit.dispatch({method:'subscribe',subscription:subscription.subscription},command=>socket!.send(JSON.stringify(command)));
   const [,result]=await wait(Promise.all([ack.promise,snapshot.promise]),until);
   unsubscribeRequested=true;
   permit.dispatch({method:'unsubscribe',subscription:subscription.subscription},command=>socket!.send(JSON.stringify(command)));
   const cleanupUntil=Date.now()+this.cleanupTimeoutMs;
   await wait(unsubscribed.promise,cleanupUntil);
   await wait(connection.whenIdle(),cleanupUntil);
   cleaned=true;
   assertClock();if(result.observedAt>Date.now())fail();
   return result;
   }finally{cleaned=true;detach();}
  }catch(error){
   // Termination is an abort, never evidence of a clean provider close. The
   // concrete quota retains uncertainty until genuine transport evidence.
   if(session){this.abort(session);await bounded(connection.uncertain(),Date.now()+this.cleanupTimeoutMs).catch(()=>{});}
   else{socket?.terminate();await this.cancelUnsent(connection);}
   throw error;
  }
 }
}
