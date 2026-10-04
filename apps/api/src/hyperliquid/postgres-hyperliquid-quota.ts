import {randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {TLSSocket} from 'node:tls';
import WebSocket from 'ws';
import {and,eq,gt,ne,sql} from 'drizzle-orm';
import {hyperliquidEgressQuota as quota,hyperliquidWsLeases as leases} from '@trading-dashboard/shared/database';
import type { UnitOfWork,DbTransaction } from '../db/unit-of-work.js';
import {assertOriginalLiveRiskSession,type LiveRiskDatabaseSession} from '../copy/live/postgres-live-risk-scope.js';
import {LiveBoundaryError,type LiveNetwork} from '../copy/live/wallet-authorization.js';
import {HYPERLIQUID_STALE_LEASE_RECLAIM_MS,planHyperliquidQuota,quotaSubscription,type HyperliquidRestLane,type HyperliquidQuotaLease,type HyperliquidQuotaRequest,type HyperliquidQuotaSubscription} from './hyperliquid-global-quota.js';
import {freezeLiveReservation} from '../copy/live/live-risk-reservation.js';
import {liveSourceDigest} from '../copy/live/copy-live-source-evidence.js';

export interface HyperliquidQuotaBinding {readonly egressKey:string;readonly ownerId:string;}
export interface HyperliquidSendPermit {assertFresh():void;dispatch<T>(work:()=>T):T;}
export type HyperliquidQuotaPermit=HyperliquidSendPermit;
export interface HyperliquidCommandPermit {dispatch<T>(command:Readonly<Record<string,unknown>>,work:(captured:Readonly<Record<string,unknown>>)=>T):T;}
/** Only the original transport object can acknowledge cleanup: this port has
 * no caller-supplied close/ACK proof or attach-by-id recovery API. */
export interface HyperliquidSocketQuota {
  attach(socket:WebSocket):void;
  cancelBeforeConnect():Promise<void>;
  subscribe(subscriptions:readonly HyperliquidQuotaSubscription[],deadline:number,prepayCleanup:boolean,prepayClose?:boolean):Promise<HyperliquidCommandPermit>;
  unsubscribe(subscriptions:readonly HyperliquidQuotaSubscription[],deadline:number):Promise<HyperliquidCommandPermit>;
  ping(deadline:number):Promise<HyperliquidSendPermit>;
  renew(deadline:number):Promise<void>;
  uncertain():Promise<void>;
  close(deadline:number):Promise<void>;
  whenIdle():Promise<void>;
}
export interface BoundHyperliquidQuota {
  acquireRest(weight:number,deadline:number,lane?:HyperliquidRestLane):Promise<HyperliquidSendPermit>;
  reserveSocket(deadline:number,network?:LiveNetwork):Promise<{readonly connect:HyperliquidSendPermit;readonly connection:HyperliquidSocketQuota}>;
}
const fail=(code:string):never=>{throw new LiveBoundaryError(code);};
function identifier(v:unknown):asserts v is string {if(typeof v!=='string'||v.length<1||v.length>128||/[\s\p{Cc}\p{Cf}]/u.test(v))fail('hyperliquid_quota_invalid');}
function capture(raw:HyperliquidQuotaBinding):Readonly<HyperliquidQuotaBinding>{const b=structuredClone(raw);identifier(b?.egressKey);identifier(b.ownerId);return Object.freeze(b);}
type Queue={tail:Promise<unknown>;pending:number};
/** Project egress alias must be the same for every process sharing an IP. A
 * transaction contains SQL only; no transport or provider call occurs here. */
export class PostgresHyperliquidQuota {
  private readonly queues=new WeakMap<LiveRiskDatabaseSession,Queue>();
  constructor(private readonly uow:UnitOfWork,private readonly now=Date.now,private readonly monotonic=()=>performance.now()){}
  bindUnscoped(identity:HyperliquidQuotaBinding):BoundHyperliquidQuota {return this.bind(capture(identity));}
  bindOriginal(session:LiveRiskDatabaseSession,identity:HyperliquidQuotaBinding):BoundHyperliquidQuota {
    assertOriginalLiveRiskSession(session);return this.bind(capture(identity),session);
  }
  private guard(session?:LiveRiskDatabaseSession){if(session)assertOriginalLiveRiskSession(session);}
  private deadline(deadline:number){const now=this.now();if(!Number.isSafeInteger(now)||now<=0||!Number.isSafeInteger(deadline)||deadline<=now||deadline>now+5000)fail('hyperliquid_quota_expired');}
  private fence(deadline:number,session?:LiveRiskDatabaseSession):()=>void {
    this.guard(session);this.deadline(deadline);const wall=this.now(),started=this.monotonic(),monotonicUntil=started+deadline-wall;
    if(!Number.isFinite(started))fail('hyperliquid_quota_expired');
    return ()=>{this.guard(session);this.deadline(deadline);const now=this.monotonic();if(!Number.isFinite(now)||now<started||now>monotonicUntil)fail('hyperliquid_quota_expired');};
  }
  private permit(fresh:()=>void):HyperliquidSendPermit {
    let used=false,running=false;const assertFresh=()=>{fresh();if(used&&!running)fail('hyperliquid_quota_permit_lost');};return Object.freeze({assertFresh,dispatch:<T>(work:()=>T):T=>{
      fresh();if(used||typeof work!=='function')fail('hyperliquid_quota_permit_lost');used=true;running=true;try{return work();}finally{running=false;}
    }});
  }
  private queue<T>(session:LiveRiskDatabaseSession|undefined,work:()=>Promise<T>):Promise<T>{
    this.guard(session);if(!session)return work();
    let queue=this.queues.get(session);if(!queue){queue={tail:Promise.resolve(),pending:0};this.queues.set(session,queue);}
    if(queue.pending>=64)return Promise.reject(new LiveBoundaryError('hyperliquid_quota_queue_full'));
    queue.pending++;const result=queue.tail.catch(()=>{}).then(()=>{this.guard(session);return work();});
    queue.tail=result.catch(()=>{}).finally(()=>{queue!.pending--;});return result;
  }
  private async apply(binding:HyperliquidQuotaBinding,request:(now:number,sendUntil:number)=>HyperliquidQuotaRequest,deadline:number|undefined,session?:LiveRiskDatabaseSession,evidence?:{leaseId:string;record:Readonly<Record<string,unknown>>}):Promise<()=>void>{
    const fresh=deadline===undefined?()=>this.guard(session):this.fence(deadline,session);
    const cleanup=evidence?freezeLiveReservation(structuredClone(evidence)):undefined;
    if(cleanup&&Buffer.byteLength(JSON.stringify(cleanup.record))>524288)fail('hyperliquid_quota_invalid');
    await this.queue(session,async()=>{
      const transaction=async(tx:DbTransaction)=>{
        const held=async()=>{if(session)await session.scope.assertHeld();};
        await tx.execute(sql`set local statement_timeout = '5000ms'`);await held();
        await tx.execute(sql`set local idle_in_transaction_session_timeout = '5000ms'`);await held();
        await tx.insert(quota).values({egressKey:binding.egressKey,events:[],updatedAt:sql`date_trunc('milliseconds',clock_timestamp())`}).onConflictDoNothing();await held();
        const rows=await tx.select().from(quota).where(eq(quota.egressKey,binding.egressKey)).for('update');await held();
        const localBeforeClock=this.now();
        const clock=await tx.execute<{now:string}>(sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as now`);await held();
        const dbNow=Number(clock.rows[0]?.now);if(!Number.isSafeInteger(dbNow)||dbNow<=0||rows.length!==1)fail('hyperliquid_quota_invalid');
        const localAfterClock=this.now();if(Math.abs(dbNow-localBeforeClock)>1000||Math.abs(dbNow-localAfterClock)>1000)fail('hyperliquid_quota_clock_skew');
        const remaining=deadline===undefined?0:deadline-localBeforeClock;if(deadline!==undefined&&(remaining<=0||remaining>5000))fail('hyperliquid_quota_expired');
        const planned=request(dbNow,dbNow+remaining),referenced='leaseId'in planned?planned.leaseId:undefined;
        // A close/ACK operation can reference a nonclosed row only. Closed
        // historical rows are retained but never scanned as active capacity.
        // Leases past the stale margin no longer count, so they are not scanned
        // either (they would otherwise fill the bounded scan and hide live rows);
        // the one a request names is still read so its owner can record close
        // evidence for it.
        const stored=await tx.select().from(leases).where(and(eq(leases.egressKey,binding.egressKey),ne(leases.state,'closed'),gt(leases.leaseUntil,new Date(dbNow-HYPERLIQUID_STALE_LEASE_RECLAIM_MS)))).limit(11);await held();
        if(referenced!==undefined&&!stored.some(l=>l.id===referenced)){stored.push(...await tx.select().from(leases).where(and(eq(leases.egressKey,binding.egressKey),ne(leases.state,'closed'),eq(leases.id,referenced))).limit(1));await held();}
        const previous=rows[0]!,state={egressKey:previous.egressKey,revision:previous.revision,events:previous.events,updatedAt:previous.updatedAt.getTime()},captured:HyperliquidQuotaLease[]=stored.map(({cleanupEvidence:_cleanupEvidence,cleanupEvidenceDigest:_cleanupEvidenceDigest,...l})=>({...l,leaseUntil:l.leaseUntil.getTime(),latestAllowedSendAt:l.latestAllowedSendAt.getTime(),createdAt:l.createdAt.getTime(),updatedAt:l.updatedAt.getTime(),closedAt:l.closedAt?.getTime()??null}));
        const plan=planHyperliquidQuota({now:dbNow,state,leases:captured,request:planned});
        const result=await tx.update(quota).set({revision:plan.state.revision,events:structuredClone(plan.state.events) as typeof previous.events,updatedAt:new Date(dbNow)}).where(and(eq(quota.egressKey,binding.egressKey),eq(quota.revision,previous.revision))).returning({key:quota.egressKey});await held();if(result.length!==1)fail('hyperliquid_quota_conflict');
        for(const l of plan.leases){
          const old=stored.find(s=>s.id===l.id);if(old&&old.revision===l.revision)continue;
          const record={...l,subscriptions:structuredClone(l.subscriptions) as typeof leases.$inferInsert.subscriptions,leaseUntil:new Date(l.leaseUntil),latestAllowedSendAt:new Date(l.latestAllowedSendAt),createdAt:new Date(l.createdAt),updatedAt:new Date(l.updatedAt),closedAt:l.closedAt===null?null:new Date(l.closedAt),...(cleanup?.leaseId===l.id?{cleanupEvidence:structuredClone(cleanup.record) as Record<string,unknown>,cleanupEvidenceDigest:liveSourceDigest(cleanup.record)}:{})};
          if(old){const changed=await tx.update(leases).set(record).where(and(eq(leases.id,l.id),eq(leases.revision,old.revision),eq(leases.fenceToken,l.fenceToken),eq(leases.ownerId,old.ownerId))).returning({id:leases.id});await held();if(changed.length!==1)fail('hyperliquid_quota_lease_lost');}
          else {await tx.insert(leases).values(record);await held();}
        }
        fresh();
      };
      if(session)await session.transaction(transaction);else await this.uow.run(transaction);
    });
    // Completion fence includes COMMIT. A failed fence retains all durable
    // charges; it never issues a replacement or refunds an uncertain send.
    fresh();return fresh;
  }
  private bind(binding:HyperliquidQuotaBinding,session?:LiveRiskDatabaseSession):BoundHyperliquidQuota {
    const apply=(request:(now:number,sendUntil:number)=>HyperliquidQuotaRequest,deadline?:number)=>this.apply(binding,request,deadline,session);
    return Object.freeze({acquireRest:async(weight:number,deadline:number,lane?:HyperliquidRestLane)=>{
      if(lane!==undefined&&lane!=='background')fail('hyperliquid_quota_invalid');
      const id=randomUUID(),fresh=await apply((_now,sendUntil)=>({kind:'rest',id,weight,sendUntil,...(lane?{lane}:{})}),deadline);return this.permit(fresh);
    },reserveSocket:async(deadline:number,network:LiveNetwork='testnet')=>{
      if(network!=='testnet'&&network!=='mainnet')fail('hyperliquid_quota_invalid');
      const id=randomUUID(),fenceToken=randomBytes(32).toString('hex'),socketId=randomUUID(),ownerId=binding.ownerId,source={leaseId:id,fenceToken,ownerId};
      const freshConnect=await apply((now,sendUntil)=>({kind:'connect',id:randomUUID(),sendUntil,lease:{id,egressKey:binding.egressKey,socketId,fenceToken,ownerId,leaseUntil:now+60000,latestAllowedSendAt:sendUntil}}),deadline);
      const connect=this.permit(freshConnect);let socket:WebSocket|undefined,connected=false,canceled=false,cleanup:Promise<unknown>=Promise.resolve(),prepaidClose:HyperliquidSendPermit|undefined,peerFinished=false,peerReleased=false,peerDurablyReleased=false;
      let finishPeer!:(clean:boolean)=>void;const peerClosed=new Promise<boolean>(resolve=>{finishPeer=resolve;});
      let faulted=false,outstandingCommands=0;const activeSubscriptions=new Set<string>(),pendingUnsub=new Set<string>(),acknowledged=new Map<string,{receivedAt:number;raw:Readonly<Record<string,unknown>>}>(),cleanupAcknowledgements=new Map<string,{receivedAt:number;raw:Readonly<Record<string,unknown>>}>(),transportFault=()=>{if(faulted)return;faulted=true;void enqueue(()=>apply(()=>({kind:'uncertain',...source}))).catch(()=>{});};
      const enqueue=(work:()=>Promise<unknown>):Promise<void>=>{const next=cleanup.catch(()=>{}).then(work).then(()=>{});cleanup=next;void next.catch(()=>{});return next;};
      const evidence=(record:Record<string,unknown>)=>({leaseId:id,record:freezeLiveReservation({version:1,network,leaseId:id,socketId,fenceToken,ownerId,...record})});
      const drainAcknowledgements=async()=>{
        while(acknowledged.size){const entries=[...acknowledged.entries()].slice(0,350),ids=entries.map(([key])=>key),proof=evidence({kind:'unsubscribe',acknowledgements:entries.map(([subscriptionId,ack])=>({subscriptionId,...ack}))});
          await this.apply(binding,()=>({kind:'ack_unsubscribe',...source,subscriptionIds:ids}),undefined,session,proof);ids.forEach(key=>acknowledged.delete(key));}
      };
      const drain=async(checkFault:boolean)=>{
        let observed:Promise<unknown>;do{
          observed=cleanup;await observed;
          if(acknowledged.size)await enqueue(drainAcknowledgements);
        }while(observed!==cleanup||acknowledged.size);
        if(checkFault&&faulted)fail('hyperliquid_quota_lease_lost');
      };
      const commandPermit=(commands:readonly Readonly<Record<string,unknown>>[],fresh:()=>void):HyperliquidCommandPermit=>{
        const remaining=commands.map(c=>structuredClone(c));outstandingCommands+=remaining.length;return Object.freeze({dispatch:<T>(command:Readonly<Record<string,unknown>>,work:(captured:Readonly<Record<string,unknown>>)=>T):T=>{
          fresh();if(faulted||!socket||socket.readyState!==WebSocket.OPEN||typeof work!=='function')fail('hyperliquid_quota_lease_lost');
          const captured=structuredClone(command),i=remaining.findIndex(c=>isDeepStrictEqual(c,captured));if(i<0)fail('hyperliquid_quota_permit_lost');remaining.splice(i,1);outstandingCommands--;
          if(captured.method==='unsubscribe')pendingUnsub.add(quotaSubscription(network,captured.subscription as Record<string,unknown>).id);
          const outbound=freezeLiveReservation(captured);fresh();return work(outbound);
        }});
      };
      const connection:HyperliquidSocketQuota=Object.freeze({
        cancelBeforeConnect:async()=>{
          this.guard(session);if(connected||canceled||socket)fail('hyperliquid_quota_permit_lost');canceled=true;
          const proof=evidence({kind:'connect_not_dispatched',receivedAt:this.now()});
          await enqueue(()=>this.apply(binding,()=>({kind:'closed',...source}),undefined,session,proof));
        },
        attach:(value:WebSocket)=>{
          freshConnect();if(socket||!connected||!(value instanceof WebSocket)||value.url!==`wss://api.hyperliquid${network==='testnet'?'-testnet':''}.xyz/ws`)fail('hyperliquid_quota_lease_lost');socket=value;
          const hostname=`api.hyperliquid${network==='testnet'?'-testnet':''}.xyz`;
          let native:TLSSocket|undefined,peerEndedAt:number|undefined,nativeClosedAt:number|undefined,localAbort=false,nativeFailed=false;
          const actualNative=()=> (value as WebSocket&{_socket?:unknown})._socket;
          const sameTls=()=>native instanceof TLSSocket&&actualNative()===native&&native.encrypted===true&&native.authorized===true&&native.servername===hostname;
          const emptyWrites=()=>native?.writableLength===0&&value.bufferedAmount===0;
          let restore=()=>{};
          const captureNative=()=>{
            const candidate=actualNative();if(native||!(candidate instanceof TLSSocket)||candidate.encrypted!==true||candidate.authorized!==true||candidate.servername!==hostname||candidate.destroyed)return;
            native=candidate;
            const ended=()=>{if(!localAbort&&!nativeFailed&&sameTls()&&emptyWrites()&&candidate.readableEnded)peerEndedAt=this.now();};
            const closed=(hadError:boolean)=>{if(hadError||!sameTls()||!candidate.destroyed)nativeFailed=true;else nativeClosedAt=this.now();};
            const failed=()=>{nativeFailed=true;};
            // ws handles end/close synchronously and may call end/destroy or
            // emit its 1006 before later listeners. Capture original events first.
            candidate.prependOnceListener('end',ended);candidate.prependOnceListener('close',closed);candidate.prependOnceListener('error',failed);
            const terminate=value.terminate,destroy=candidate.destroy,end=candidate.end,reset=candidate.resetAndDestroy;
            const abort=()=>{if(peerEndedAt===undefined)localAbort=true;};
            value.terminate=function(){abort();return terminate.call(this);};
            candidate.destroy=function(error?:Error){abort();return destroy.call(this,error);};
            candidate.end=function(...args:unknown[]){abort();return Reflect.apply(end,this,args) as TLSSocket;};
            candidate.resetAndDestroy=function(){abort();return reset.call(this);};
            restore=()=>{value.terminate=terminate;candidate.destroy=destroy;candidate.end=end;candidate.resetAndDestroy=reset;candidate.off('end',ended);candidate.off('close',closed);candidate.off('error',failed);};
          };
          const opened=()=>{captureNative();void enqueue(()=>apply(()=>({kind:'opened',...source}))).catch(transportFault);};
          value.on('open',opened);if(value.readyState===WebSocket.OPEN)opened();
          value.on('error',transportFault);
          value.on('close',(code:number,reason?:Buffer)=>{
            if(peerFinished)return;peerFinished=true;
            const receivedAt=this.now(),clean=code===1000||code===1001;
            const eof=code===1006&&!faulted&&!nativeFailed&&!localAbort&&sameTls()&&emptyWrites()&&native!.destroyed&&value.readyState===WebSocket.CLOSED&&peerEndedAt!==undefined&&nativeClosedAt!==undefined&&Number.isSafeInteger(peerEndedAt)&&peerEndedAt>0&&peerEndedAt<=nativeClosedAt&&nativeClosedAt<=receivedAt&&Number.isSafeInteger(receivedAt)&&activeSubscriptions.size===0&&pendingUnsub.size===0&&outstandingCommands===0;
            peerReleased=clean||eof;finishPeer(peerReleased);
            const proof=clean?evidence({kind:'close',receivedAt,code,reasonHex:reason&&reason.byteLength<=256?reason.toString('hex'):null}):eof?evidence({kind:'peer_eof',receivedAt,code,clean:false,servername:hostname,peerEndedAt,nativeClosedAt,hadError:false,acknowledgements:[...cleanupAcknowledgements.entries()].map(([subscriptionId,ack])=>({subscriptionId,...ack}))}):undefined;
            restore();
            // Transport cleanup never changes any execution journal or financial
            // uncertainty. A missing WebSocket close frame remains recorded1006.
            void enqueue(async()=>{await drainAcknowledgements();await this.apply(binding,()=>({kind:peerReleased?'closed':'uncertain',...source}),undefined,session,proof);peerDurablyReleased=peerReleased;}).catch(()=>{});
          });
          value.on('message',(raw:WebSocket.RawData)=>{
            try{
              const bytes=Array.isArray(raw)?raw.reduce((sum,b)=>sum+b.byteLength,0):raw.byteLength;
              if(faulted)return;if(bytes>8*1024*1024)throw Error();const text=Array.isArray(raw)?Buffer.concat(raw).toString():raw instanceof ArrayBuffer?Buffer.from(raw).toString():String(raw),payload=JSON.parse(text);if(payload?.channel!=='subscriptionResponse'||payload.data?.method!=='unsubscribe')return;
              if(bytes>1024)throw Error();
              const sub=quotaSubscription(network,payload.data.subscription);if(!pendingUnsub.has(sub.id))throw Error();pendingUnsub.delete(sub.id);
              if(acknowledged.size>=1000||cleanupAcknowledgements.size>=1000||acknowledged.has(sub.id))throw Error();activeSubscriptions.delete(sub.id);const ack={receivedAt:this.now(),raw:freezeLiveReservation(structuredClone(payload))};acknowledged.set(sub.id,ack);cleanupAcknowledgements.set(sub.id,ack);
            }catch{transportFault();}
          });
        },
        subscribe:async(supplied:readonly HyperliquidQuotaSubscription[],until:number,prepayCleanup:boolean,prepayClose=false)=>{
          const subs=structuredClone(supplied);if(subs.some(s=>s.network!==network))fail('hyperliquid_quota_invalid');await cleanup;
          if(prepayClose&&prepaidClose)fail('hyperliquid_quota_permit_lost');
          if(activeSubscriptions.size===0&&pendingUnsub.size===0&&outstandingCommands===0&&acknowledged.size===0)cleanupAcknowledgements.clear();
          const fresh=await apply((_now,sendUntil)=>({kind:'subscribe',id:randomUUID(),...source,sendUntil,subscriptions:subs,prepayCleanup,prepayClose}),until);
          subs.forEach(sub=>activeSubscriptions.add(sub.id));
          if(prepayClose)prepaidClose=this.permit(fresh);
          return commandPermit(subs.flatMap(s=>[{method:'subscribe',subscription:s.subscription},...(prepayCleanup?[{method:'unsubscribe',subscription:s.subscription}]:[])]),fresh);
        },
        unsubscribe:async(supplied:readonly HyperliquidQuotaSubscription[],until:number)=>{
          const subs=structuredClone(supplied);subs.forEach(s=>{if(!isDeepStrictEqual(quotaSubscription(network,s.subscription),s))fail('hyperliquid_quota_invalid');});await cleanup;
          const fresh=await apply((_now,sendUntil)=>({kind:'unsubscribe',id:randomUUID(),...source,sendUntil,subscriptionIds:subs.map(s=>s.id)}),until);
          return commandPermit(subs.map(s=>({method:'unsubscribe',subscription:s.subscription})),fresh);
        },
        ping:async(until:number)=>{await cleanup;const fresh=await apply((_now,sendUntil)=>({kind:'ping',id:randomUUID(),...source,sendUntil}),until);return this.permit(fresh);},
        renew:async(until:number)=>{await cleanup;await apply((now,sendUntil)=>({kind:'renew',...source,sendUntil,leaseUntil:now+60000}),until);},
        uncertain:()=>enqueue(()=>apply(()=>({kind:'uncertain',...source}))),whenIdle:()=>drain(true),
        close:async(until:number)=>{
          const fresh=this.fence(until,session);await drain(false);
          if(peerFinished){if(!peerDurablyReleased)fail('hyperliquid_quota_lease_lost');fresh();return;}
          if(!socket)fail('hyperliquid_quota_lease_lost');
          const permit=prepaidClose??this.permit(await apply((_now,sendUntil)=>({kind:'close',id:randomUUID(),...source,sendUntil}),until));
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{
            const timeout=new Promise<boolean>((_resolve,reject)=>{timer=setTimeout(()=>reject(new LiveBoundaryError('hyperliquid_quota_expired')),Math.max(1,until-this.now()));});
            permit.dispatch(()=>socket!.close(1000));prepaidClose=undefined;
            if(!await Promise.race([peerClosed,timeout]))fail('hyperliquid_quota_lease_lost');await drain(false);if(!peerDurablyReleased)fail('hyperliquid_quota_lease_lost');fresh();
          }finally{clearTimeout(timer);}
        },
      });
      return Object.freeze({connect:Object.freeze({assertFresh:()=>{if(canceled)fail('hyperliquid_quota_permit_lost');connect.assertFresh();},dispatch:<T>(work:()=>T):T=>{if(canceled)fail('hyperliquid_quota_permit_lost');return connect.dispatch(()=>{connected=true;return work();});}}),connection});
    }});
  }
}
