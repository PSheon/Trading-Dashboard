import WebSocket from 'ws';
import { z } from 'zod';
import { MAX_LIVE_PERP_DEXES, LIVE_DEX_NAME } from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';
import {HyperliquidGlobalTransport} from '../../hyperliquid/hyperliquid-global-transport.js';
import {quotaSubscription} from '../../hyperliquid/hyperliquid-global-quota.js';
import type {HyperliquidSocketQuota,HyperliquidCommandPermit} from '../../hyperliquid/postgres-hyperliquid-quota.js';

export interface LiveAllDexsStateEvidence {
  readonly network: 'testnet' | 'mainnet'; readonly accountAddress: string; readonly observedAt: number; readonly data: unknown;
}
export interface LiveOrderVenueEvidence {
  readonly dex: string; readonly user: string; readonly observedAt: number; readonly receivedAt: number; readonly orders: readonly unknown[];
}
export interface LiveAllDexsOrderEvidence {
  readonly network: 'testnet' | 'mainnet'; readonly accountAddress: string; readonly observedAt: number; readonly completedAt: number;
  readonly requestedDexes: readonly string[]; readonly venues: readonly LiveOrderVenueEvidence[];
}
export interface LiveAllDexsAccountEvidence {
  readonly state: LiveAllDexsStateEvidence; readonly orders: LiveAllDexsOrderEvidence;
}
export interface LiveAllDexsAccountSource {
  read(accountAddress: string, timeoutMs: number): Promise<LiveAllDexsStateEvidence>;
  readOrders?(accountAddress: string, dexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsOrderEvidence>;
  /** `signal`: the caller gave up (a sibling read failed). Checked before a
   * socket is reserved and before anything is subscribed, so abandoned work
   * holds no connection, subscriptions or uncertain lease. */
  readAccount?(accountAddress: string, dexes: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<LiveAllDexsAccountEvidence>;
  close?(): void|Promise<void>;
}
const BATCH = 90, MESSAGE_LIMIT = 1800, WINDOW = 60_000, MIN_ORDER_INTERVAL = 1000;
const dexList = z.array(z.string().max(40).refine((v) => v === '' || LIVE_DEX_NAME.test(v))).min(1).max(MAX_LIVE_PERP_DEXES);
const fail = (code: string): never => { throw new LiveBoundaryError(code); };

/** Official fixed-network snapshot subscriptions. One reusable socket; bounded
 * batches and rolling command admission include cleanup before any sends. */
export class HyperliquidAllDexsAccountSource implements LiveAllDexsAccountSource {
  private socket?: WebSocket;
  private busy = false;
  private readonly sentReservations: number[] = [];
  private readonly connections: number[] = [];
  private lastOrderAttempt?: number;
  private globalSocket?:HyperliquidSocketQuota;
  private socketContext?:object;
  private socketNew=false;
  private heartbeatTimer?:ReturnType<typeof setInterval>;
  private heartbeatTask?:Promise<void>;
  private disposed=false;
  constructor(private readonly now = Date.now,
    private readonly createSocket = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options),
    readonly network: 'testnet' | 'mainnet' = 'testnet',private readonly global?:HyperliquidGlobalTransport,
    /** `closeAfterRead`: an all-venue read subscribes every venue and then
     * closes its socket (one prepaid close) instead of unsubscribing each
     * venue: 270 WS units for 268 dexes instead of 538, and no unsubscribe
     * round trips. For a source whose reads are occasional (the api's
     * account-mode absence proof); a new socket per read. */
    private readonly options:{readonly closeAfterRead?:boolean}={}) {
    if (!['testnet', 'mainnet'].includes(network)) fail('live_account_source_mismatch');
    if(global!==undefined&&!(global instanceof HyperliquidGlobalTransport))fail('live_account_source_mismatch');
  }

  private reserve(count: number): void {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail('live_account_source_time_invalid');
    while (this.sentReservations.length && this.sentReservations[0]! <= now - WINDOW) this.sentReservations.shift();
    if (this.sentReservations.length + count > MESSAGE_LIMIT) fail('live_account_ws_message_budget');
    for (let i = 0; i < count; i++) this.sentReservations.push(now);
  }
  private connection(timeoutMs: number,deadline:number): WebSocket|Promise<WebSocket> {
    if(this.global&&this.heartbeatTask)return this.heartbeatTask.then(()=>this.connection(this.remaining(deadline),deadline));
    if(this.global&&this.socket&&this.socketContext!==this.global.contextIdentity())fail('live_account_ws_context_changed');
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) {
      const now = this.now();
      while (this.connections.length && this.connections[0]! <= now - WINDOW) this.connections.shift();
      if (this.connections.length >= 25) fail('live_account_ws_connection_budget');
      this.connections.push(now);
      const create=()=>this.createSocket(this.network === 'testnet' ? 'wss://api.hyperliquid-testnet.xyz/ws' : 'wss://api.hyperliquid.xyz/ws', {
        maxPayload: 8 * 1024 * 1024, handshakeTimeout: timeoutMs, followRedirects: false, autoPong: false,
      });
      const retain=(created:WebSocket)=>{this.socket=created;const clear=()=>{if(this.socket===created){this.socket=undefined;clearInterval(this.heartbeatTimer);this.heartbeatTimer=undefined;}};created.on('error',clear);created.on('close',clear);return created;};
      if(this.global)return (async()=>{const reservation=await this.global!.currentQuota().reserveSocket(deadline,this.network);let created:WebSocket|undefined;try{if(this.disposed)throw new LiveBoundaryError('live_account_aggregate_unavailable');created=reservation.connect.dispatch(create);reservation.connection.attach(created);}catch(error){created?.on('error',()=>{});created?.terminate();await reservation.connection.cancelBeforeConnect().catch(()=>reservation.connection.uncertain().catch(()=>{}));throw error;}this.globalSocket=reservation.connection;this.socketContext=this.global!.contextIdentity();this.socketNew=true;retain(created);if(!this.global!.isOriginal())this.startHeartbeat(created,reservation.connection);return created;})();
      return retain(create());
    }
    return this.socket!;
  }
  private startHeartbeat(socket:WebSocket,quota:HyperliquidSocketQuota):void{
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer=setInterval(()=>{
      if(this.disposed||this.busy||this.heartbeatTask||this.socket!==socket||socket.readyState!==WebSocket.OPEN)return;
      const task=(async()=>{try{
        const deadline=this.now()+5000;await quota.whenIdle();await quota.renew(deadline);const permit=await quota.ping(deadline);
        if(this.disposed||this.socket!==socket||socket.readyState!==WebSocket.OPEN)return;
        permit.dispatch(()=>socket.send(JSON.stringify({method:'ping'})));
      }catch{clearInterval(this.heartbeatTimer);this.heartbeatTimer=undefined;await this.failedSocket(socket,this.now()+5000);}})();
      this.heartbeatTask=task;void task.finally(()=>{if(this.heartbeatTask===task)this.heartbeatTask=undefined;}).catch(()=>{});
    },20000);this.heartbeatTimer.unref?.();
  }
  private async terminateAndFlush(socket:WebSocket):Promise<void>{
    const quota=this.globalSocket;if(!quota){socket.terminate();return;}
    let timer:ReturnType<typeof setTimeout>|undefined,closed:(()=>void)|undefined;
    try{
      const cleanup=(async()=>{
        if(socket.readyState!==WebSocket.CLOSED){const peer=new Promise<void>(resolve=>{closed=resolve;socket.once('close',closed);});socket.terminate();await peer;}
        await quota.whenIdle().catch(()=>{});
      })();
      await Promise.race([cleanup,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);
    }finally{clearTimeout(timer);if(closed)socket.off('close',closed);}
  }
  private async failedSocket(socket:WebSocket,deadline:number):Promise<void>{
    if(this.globalSocket&&deadline>this.now()){try{await this.globalSocket.close(deadline);}catch{await this.terminateAndFlush(socket);}}
    else await this.terminateAndFlush(socket);
    if(this.socket===socket)this.socket=undefined;
  }
  private remaining(deadline:number):number{const left=deadline-this.now();if(left<=0||left>5000)fail('live_account_orders_deadline_exceeded');return left;}
  /** Reads end with a close of their socket, not with unsubscribes. */
  private closesAfterRead():boolean{return this.global!==undefined&&(this.options.closeAfterRead===true||this.global.isOriginal());}
  private async commands(subscriptions:readonly Record<string,unknown>[],deadline:number,unsubscribe=true):Promise<HyperliquidCommandPermit|undefined>{
    if(!this.global)return;const quota=this.globalSocket;if(!quota)return fail('live_account_aggregate_unavailable');
    await quota.whenIdle();if(!this.socketNew)await quota.renew(deadline);this.socketNew=false;return quota.subscribe(subscriptions.map(body=>quotaSubscription(this.network,body)),deadline,unsubscribe,this.closesAfterRead());
  }
  private send(socket:WebSocket,command:Record<string,unknown>,permit?:HyperliquidCommandPermit):void{
    if(this.global){if(!permit)return fail('live_account_aggregate_unavailable');permit.dispatch(command,captured=>socket.send(JSON.stringify(captured)));}
    else socket.send(JSON.stringify(command));
  }
  private admit(timeoutMs: number): void {
    if (this.disposed||this.busy || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) fail('live_account_aggregate_unavailable');
  }

  async read(accountAddress: string, timeoutMs: number): Promise<LiveAllDexsStateEvidence> {
    const user = address(accountAddress), observedAt = this.now();
    this.admit(timeoutMs); this.reserve(2); this.busy = true;
    let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let open: (() => void) | undefined, message: ((raw: WebSocket.RawData) => void) | undefined, unavailable: (() => void) | undefined;
    let succeeded = false;
    try {
      const deadline=observedAt+timeoutMs,connecting=this.connection(this.remaining(deadline),deadline);socket = connecting instanceof Promise?await connecting:connecting;
      const permit=this.global?await this.commands([{type:'allDexsClearinghouseState',user}],deadline):undefined;
      const result = await new Promise<LiveAllDexsStateEvidence>((resolve, reject) => {
        const deny = (code = 'live_account_aggregate_unavailable') => reject(new LiveBoundaryError(code));
        let acknowledged = false, phase: 'subscribe' | 'unsubscribe' = 'subscribe', bytes = 0, frames = 0;
        let evidence: LiveAllDexsStateEvidence | undefined;
        open = () => { try { this.send(socket!,{ method: 'subscribe',
          subscription: { type: 'allDexsClearinghouseState', user } },permit); } catch { deny(); } };
        message = (raw) => {
          try {
            bytes += Buffer.byteLength(String(raw)); frames++;
            if (bytes > 16 * 1024 * 1024 || frames > 4000) { deny('live_account_unbounded_evidence'); return; }
            const payload = JSON.parse(String(raw));
            if (payload.channel === 'error') { deny(); return; }
            if (payload.channel === 'subscriptionResponse' && payload.data?.subscription?.type === 'allDexsClearinghouseState') {
              const scope = payload.data.subscription;
              if (payload.data.method !== phase || typeof scope.user !== 'string' || address(scope.user) !== user || phase === 'subscribe' && acknowledged) {
                deny('live_account_order_ack_mismatch'); return;
              }
              if (phase === 'unsubscribe') { if (!evidence) { deny(); return; } resolve(evidence); }
              else acknowledged = true;
              return;
            }
            if (payload.channel !== 'allDexsClearinghouseState') return;
            if (!acknowledged) { deny('live_account_order_ack_missing'); return; }
            if (typeof payload.data?.user !== 'string' || address(payload.data.user) !== user) { deny('live_account_source_mismatch'); return; }
            if (phase === 'unsubscribe') return;
            evidence = { network: this.network, accountAddress: user, observedAt, data: payload.data };
            phase = 'unsubscribe'; this.send(socket!,{ method: 'unsubscribe', subscription: { type: 'allDexsClearinghouseState', user } },permit);
          } catch { deny(); }
        };
        unavailable = () => deny();
        socket!.on('open', open); socket!.on('message', message); socket!.on('error', unavailable); socket!.on('close', unavailable); socket!.on('ping', unavailable);
        timer = setTimeout(() => { deny(); socket?.terminate(); }, this.remaining(deadline));
        if (socket!.readyState === WebSocket.OPEN) open();
      });
      if(this.globalSocket){await this.globalSocket.whenIdle();if(this.closesAfterRead())await this.globalSocket.close(deadline);this.remaining(deadline);}succeeded = true; return result;
    } finally {
      clearTimeout(timer);
      if (socket) {
        if (open) socket.off('open', open); if (message) socket.off('message', message);
        if (unavailable) { socket.off('error', unavailable); socket.off('close', unavailable); socket.off('ping', unavailable); }
        if(!succeeded)await this.failedSocket(socket,observedAt+timeoutMs);
      }
      this.busy = false;
    }
  }

  async readOrders(accountAddress: string, requestedDexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsOrderEvidence> {
    return (await this.readSnapshots(accountAddress, requestedDexes, timeoutMs, false)).orders;
  }
  async readAccount(accountAddress: string, requestedDexes: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<LiveAllDexsAccountEvidence> {
    const result = await this.readSnapshots(accountAddress, requestedDexes, timeoutMs, true, signal);
    if (!result.state) throw new LiveBoundaryError('live_account_aggregate_unavailable');
    return { state: result.state, orders: result.orders };
  }
  private async readSnapshots(accountAddress: string, requestedDexes: readonly string[], timeoutMs: number, includeState: boolean, signal?: AbortSignal):
    Promise<{ state?: LiveAllDexsStateEvidence; orders: LiveAllDexsOrderEvidence }> {
    const user = address(accountAddress), observedAt = this.now(), dexes = dexList.parse([...requestedDexes]);
    if (new Set(dexes).size !== dexes.length) fail('live_account_duplicate_evidence');
    this.admit(timeoutMs);
    if (signal?.aborted) fail('live_account_read_abandoned');
    if (this.lastOrderAttempt !== undefined && observedAt - this.lastOrderAttempt < MIN_ORDER_INTERVAL) fail('live_account_orders_throttled');
    this.reserve(2 * dexes.length + (includeState ? 2 : 0)); this.lastOrderAttempt = observedAt; this.busy = true;
    let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let open: (() => void) | undefined, message: ((raw: WebSocket.RawData) => void) | undefined, unavailable: (() => void) | undefined;
    let succeeded = false;
    try {
      const deadline=observedAt+timeoutMs;if(signal?.aborted)fail('live_account_read_abandoned');
      const connecting=this.connection(this.remaining(deadline),deadline);socket = connecting instanceof Promise?await connecting:connecting;
      // Nothing subscribed yet: a reusable socket stays open and clean.
      if(signal?.aborted){if(!this.global?.isOriginal())succeeded=true;fail('live_account_read_abandoned');}
      // Closing the socket ends every subscription at once (closeAfterRead).
      const unsubscribes=!(this.options.closeAfterRead===true&&this.global!==undefined);
      const permit=this.global?await this.commands([...(includeState?[{type:'allDexsClearinghouseState',user}]:[]),...dexes.map(dex=>({type:'openOrders',user,dex}))],deadline,unsubscribes):undefined;
      const result = await new Promise<{ state?: LiveAllDexsStateEvidence; orders: LiveAllDexsOrderEvidence }>((resolve, reject) => {
        let offset = 0, phase: 'subscribe' | 'unsubscribe' = 'subscribe', batch: string[] = [];
        let pending = new Set<string>(), acknowledged = new Set<string>(), bytes = 0, frames = 0, retainedOrders = 0;
        const venues = new Map<string, LiveOrderVenueEvidence>();
        let batchStarted = observedAt;
        let statePhase: 'subscribe' | 'unsubscribe' | 'done' = includeState ? 'subscribe' : 'done';
        let stateAcknowledged = false, state: LiveAllDexsStateEvidence | undefined, stopped = false;
        const deny = (code = 'live_account_orders_unavailable') => { stopped = true; reject(new LiveBoundaryError(code)); };
        const sendState = (method: 'subscribe' | 'unsubscribe') => {
          if (stopped) return;
          try { this.send(socket!,{ method, subscription: { type: 'allDexsClearinghouseState', user } },permit); }
          catch { deny(); }
        };
        const send = (method: 'subscribe' | 'unsubscribe', dex: string) => {
          if (stopped) return;
          try { this.send(socket!,{ method, subscription: { type: 'openOrders', user, dex } },permit); }
          catch { deny(); }
        };
        const next = () => {
          if (stopped) return;
          const first = offset === 0;
          // The aggregate command occupies one of the first batch's slots.
          batch = dexes.slice(offset, offset + BATCH - (first && includeState ? 1 : 0)); offset += batch.length; phase = 'subscribe';
          pending = new Set(batch); acknowledged = new Set(); batchStarted = this.now();
          if (first && includeState) sendState('subscribe');
          for (const dex of batch) send('subscribe', dex);
        };
        const finish = () => {
          if (stopped) return;
          if (phase === 'subscribe' && pending.size === 0 && batch.every((dex) => venues.has(dex))) {
            phase = 'unsubscribe'; pending = new Set(batch); if (unsubscribes) for (const dex of batch) send('unsubscribe', dex); else pending.clear();
          }
          if (phase === 'unsubscribe' && pending.size === 0 && statePhase === 'done') {
            if (offset < dexes.length) next();
            else resolve({ state, orders: { network: this.network, accountAddress: user, observedAt, completedAt: this.now(),
              requestedDexes: dexes, venues: dexes.map((dex) => venues.get(dex)!) } });
          }
        };
        open = next;
        message = (raw) => {
          if (stopped) return;
          try {
            bytes += Buffer.byteLength(String(raw));
            frames++;
            if (bytes > 16 * 1024 * 1024 || frames > 4000) { deny('live_account_unbounded_evidence'); return; }
            const payload = JSON.parse(String(raw));
            if (payload.channel === 'error') { deny(); return; }
            if (payload.channel === 'subscriptionResponse') {
              const ack = payload.data, scope = ack?.subscription;
              if (includeState && scope?.type === 'allDexsClearinghouseState') {
                if (typeof scope.user !== 'string' || address(scope.user) !== user || ack.method !== statePhase ||
                    statePhase === 'subscribe' && stateAcknowledged) { deny('live_account_order_ack_mismatch'); return; }
                if (statePhase === 'subscribe') stateAcknowledged = true;
                else { if (!state) { deny(); return; } statePhase = 'done'; finish(); }
                return;
              }
              if (scope?.type !== 'openOrders') return;
              if (typeof scope.user !== 'string' || address(scope.user) !== user || typeof scope.dex !== 'string' ||
                  ack.method !== phase || !pending.has(scope.dex)) { deny('live_account_order_ack_mismatch'); return; }
              pending.delete(scope.dex); acknowledged.add(scope.dex); finish();
            } else if (includeState && payload.channel === 'allDexsClearinghouseState') {
              if (!stateAcknowledged) { deny('live_account_order_ack_missing'); return; }
              if (typeof payload.data?.user !== 'string' || address(payload.data.user) !== user) { deny('live_account_source_mismatch'); return; }
              if (statePhase !== 'subscribe') return;
              state = { network: this.network, accountAddress: user, observedAt, data: payload.data };
              if (unsubscribes) { statePhase = 'unsubscribe'; sendState('unsubscribe'); } else { statePhase = 'done'; finish(); }
            } else if (payload.channel === 'openOrders') {
              const row = payload.data;
              // Still subscribed (closeAfterRead): a later update of a venue an
              // earlier batch already captured is not evidence of this read.
              if (!unsubscribes && row && typeof row.dex === 'string' && !batch.includes(row.dex) && venues.has(row.dex)) return;
              if (!row || typeof row.user !== 'string' || address(row.user) !== user || typeof row.dex !== 'string' ||
                  !batch.includes(row.dex) || !Array.isArray(row.orders)) { deny('live_account_source_mismatch'); return; }
              if (!acknowledged.has(row.dex)) { deny('live_account_order_ack_missing'); return; }
              retainedOrders += row.orders.length - (venues.get(row.dex)?.orders.length ?? 0);
              if (retainedOrders > 5000) { deny('live_account_unbounded_evidence'); return; }
              venues.set(row.dex, { dex: row.dex, user, observedAt: batchStarted, receivedAt: this.now(), orders: row.orders });
              finish();
            }
          } catch { deny(); }
        };
        unavailable = () => deny();
        socket!.on('open', open); socket!.on('message', message); socket!.on('error', unavailable); socket!.on('close', unavailable); socket!.on('ping', unavailable);
        timer = setTimeout(() => deny('live_account_orders_deadline_exceeded'), this.remaining(deadline));
        if (socket!.readyState === WebSocket.OPEN) open();
      });
      if(this.globalSocket){await this.globalSocket.whenIdle();if(this.closesAfterRead())await this.globalSocket.close(deadline);this.remaining(deadline);}succeeded = true; return result;
    } finally {
      clearTimeout(timer);
      if (socket) {
        if (open) socket.off('open', open); if (message) socket.off('message', message);
        if (unavailable) { socket.off('error', unavailable); socket.off('close', unavailable); socket.off('ping', unavailable); }
        // Failed scans cannot leave unknown subscriptions/acks on a reusable
        // connection; successful scans waited for every unsubscribe ack.
        if(!succeeded)await this.failedSocket(socket,observedAt+timeoutMs);
      }
      this.busy = false;
    }
  }
  close(): void|Promise<void> {
    this.disposed=true;clearInterval(this.heartbeatTimer);this.heartbeatTimer=undefined;
    const socket=this.socket;this.socket=undefined;if(!socket)return this.heartbeatTask;
    if(!this.globalSocket){socket.terminate();return;}
    const quota=this.globalSocket;return (async()=>{await this.heartbeatTask;await quota.close(this.now()+5000).catch(()=>this.terminateAndFlush(socket));})();
  }
}
