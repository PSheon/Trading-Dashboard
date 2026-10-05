import { AppConfig } from "../config/app-config.js";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { WebSocket } from "ws";

import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { HyperliquidGlobalTransport } from '../hyperliquid/hyperliquid-global-transport.js';
import { quotaSubscription } from '../hyperliquid/hyperliquid-global-quota.js';
import type { HyperliquidSocketQuota } from '../hyperliquid/postgres-hyperliquid-quota.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { LIVE_PERP_COIN, MAX_LIVE_PERP_DEXES } from '../copy/live/live-market-resolver.js';
import type { HlWsIncomingMessage, HlWsTrade } from "../hyperliquid/types.js";

/** Headroom under the documented 1000 subscriptions per IP, spread over a
 * few sockets so one slow socket doesn't stall every market. */
const MAX_SUBSCRIPTIONS_PER_SOCKET = 200;
const PING_INTERVAL_MS = 30_000;
/** No message at all (not even a pong) for this long → assume dead. */
const STALE_AFTER_MS = 90_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Subscribing replays each market's recent trades, which in a quiet market
 * can be hours old. Only fresh trades mean "just traded"; anything older is
 * left to the sweeps, so a (re)connect never raises alerts on old trades. */
export const MAX_TRADE_AGE_MS = 60_000;

export interface TradeFeedHandlers {
  /** A watched address was one side of `trade`. */
  onTrade(address: string, trade: HlWsTrade): void;
  /** A socket was down from `since` until now; trades in between were lost. */
  onGap(since: number): void;
}

export interface TradeFeedStatus {
  socketsOpen: number;
  socketsTotal: number;
  markets: number;
  lastTradeAt: Date | null;
  /** Earliest time any socket went down and hasn't recovered, else null. */
  disconnectedSince: Date | null;
}

interface Shard {
  quota?:HyperliquidSocketQuota;
  opening?:Promise<void>;
  heartbeat?:Promise<void>;
  coins: string[];
  socket?: WebSocket;
  connectedOnce: boolean;
  downSince: number | null;
  attempt: number;
  lastMessageAt: number;
  pingTimer?: ReturnType<typeof setInterval>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Real-time fill discovery (W1) from the per-coin `trades` channel.
 *
 * User-specific subscriptions (`userFills`) are capped at 10 unique users
 * per IP, too few for 100 leaders. `trades` is per coin, not per user, and
 * every trade carries `users: [buyer, seller]`; subscribing to every perp
 * market (≈330 across all dexes on 2026-09-29) and filtering by address
 * sees every leader trade in about a second, whatever the number of leaders.
 *
 * A trade has no startPosition, closedPnl or fee: the caller derives the
 * position from its position book to alert at once, and stores the fill
 * itself from `userFillsByTime` afterwards.
 */
@Injectable()
export class TradeFeedService {
  private readonly logger = new Logger(TradeFeedService.name);
  private shards: Shard[] = [];
  private readonly subscribed = new Set<string>();
  private watched = new Set<string>();
  private handlers: TradeFeedHandlers | undefined;
  private lastTradeAt: Date | null = null;
  private stopped = true;
  private stopping?:Promise<void>;

  constructor(private readonly config: AppConfig, private readonly info: HyperliquidInfoClient, @Optional() private readonly global?:HyperliquidGlobalTransport) {}

  async start(handlers: TradeFeedHandlers): Promise<void> {
    await this.stopping;
    this.handlers = handlers;
    this.stopped = false;
    await this.refreshMarkets();
  }

  stop(): Promise<void> {
    if(this.stopping)return this.stopping;
    this.stopped = true;
    const shards=this.shards;
    for (const shard of shards) {
      clearInterval(shard.pingTimer);
      clearTimeout(shard.reconnectTimer);

    }
    this.shards = [];
    this.subscribed.clear();
    const work=Promise.allSettled(shards.map(async shard=>{await shard.opening?.catch(()=>{});await this.closeShard(shard);})).then(()=>{});this.stopping=work;void work.finally(()=>{if(this.stopping===work)this.stopping=undefined;});return work;
  }
  onModuleDestroy():Promise<void>{return this.stop();}

  /** Addresses to report, compared lowercase. */
  setWatched(addresses: Iterable<string>): void {
    this.watched = new Set([...addresses].map((a) => a.toLowerCase()));
  }

  /** Every listed perp market on every dex. */
  async listMarkets(): Promise<string[]> {
    // The live feed cannot start until this catalog is loaded. Keep its
    // bounded metadata calls ahead of historical fills and cache warming.
    const [dexes,metas]=await Promise.all([this.info.perpDexs("live"),this.info.allPerpMetas("live")]);
    if(dexes.length<1||dexes.length>MAX_LIVE_PERP_DEXES||metas.length!==dexes.length)throw new LiveBoundaryError('trade_feed_market_identity_invalid');
    const names=new Set<string>(),coins:string[]=[];
    for(let i=0;i<dexes.length;i++){
      const row=dexes[i],meta=metas[i];if(i===0&&row!==null)throw new LiveBoundaryError('trade_feed_market_identity_invalid');
      if(i>0&&!row){if(meta!==null)throw new LiveBoundaryError('trade_feed_market_identity_invalid');continue;}
      const dex=i===0?'':row!.name;if(names.has(dex)||!meta||!Array.isArray(meta.universe))throw new LiveBoundaryError('trade_feed_market_identity_invalid');names.add(dex);
      for(const asset of meta.universe){if(!LIVE_PERP_COIN.test(asset.name)||(dex?asset.name.split(':')[0]!==dex:asset.name.includes(':'))||coins.includes(asset.name))throw new LiveBoundaryError('trade_feed_market_identity_invalid');if(!asset.isDelisted)coins.push(asset.name);}
    }
    return coins;
  }

  /** Subscribes to markets listed since the last call (new listings, new
   * dexes). Called at start and hourly. */
  async refreshMarkets(): Promise<void> {
    const coins = (await this.listMarkets()).filter((c) => !this.subscribed.has(c));
    if (this.stopped) return;
    for (const coin of coins) {
      let shard = this.shards.find((s) => s.coins.length < MAX_SUBSCRIPTIONS_PER_SOCKET);
      if (!shard) {
        shard = { coins: [], connectedOnce: false, downSince: null, attempt: 0, lastMessageAt: Date.now() };
        this.shards.push(shard);
      }
      shard.coins.push(coin);
      this.subscribed.add(coin);
      if (shard.socket?.readyState === WebSocket.OPEN) await this.subscribe(shard, [coin]);
    }
    for (const shard of this.shards) if (!shard.socket) await this.open(shard);
    this.logger.log(`Trade feed: ${this.subscribed.size} markets on ${this.shards.length} sockets`);
  }

  status(): TradeFeedStatus {
    const down = this.shards.map((s) => s.downSince).filter((t): t is number => t !== null);
    return {
      socketsOpen: this.shards.filter((s) => s.socket?.readyState === WebSocket.OPEN).length,
      socketsTotal: this.shards.length,
      markets: this.subscribed.size,
      lastTradeAt: this.lastTradeAt,
      disconnectedSince: down.length ? new Date(Math.min(...down)) : null,
    };
  }

  /** Parses one socket message. Public for tests. */
  handleMessage(text: string): void {
    let message: HlWsIncomingMessage;
    try {
      message = JSON.parse(text) as HlWsIncomingMessage;
    } catch {
      this.logger.warn(`Unparseable WS message: ${text.slice(0, 200)}`);
      return;
    }
    if (message.channel === "error") {
      this.logger.error(`Hyperliquid WS error: ${JSON.stringify(message.data)}`);
      return;
    }
    if (message.channel !== "trades" || !Array.isArray(message.data)) return;
    const oldest = Date.now() - MAX_TRADE_AGE_MS;
    for (const trade of message.data as HlWsTrade[]) {
      if (trade.time < oldest) continue;
      this.lastTradeAt = new Date();
      for (const user of trade.users ?? []) {
        const address = user.toLowerCase();
        if (this.watched.has(address)) this.handlers?.onTrade(address, trade);
      }
    }
  }

  private network():'testnet'|'mainnet'{
    const {wsUrl,apiUrl}=this.config.value.hyperliquid;
    if(wsUrl==='wss://api.hyperliquid.xyz/ws'&&apiUrl==='https://api.hyperliquid.xyz/info')return 'mainnet';
    if(wsUrl==='wss://api.hyperliquid-testnet.xyz/ws'&&apiUrl==='https://api.hyperliquid-testnet.xyz/info')return 'testnet';
    throw new LiveBoundaryError('trade_feed_source_mismatch');
  }
  private async closeShard(shard:Shard):Promise<void>{
    const socket=shard.socket;if(!socket)return;
    try{if(!shard.quota)throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');await shard.quota.close(Date.now()+5000);await shard.quota.whenIdle();}
    catch{socket.terminate();await shard.quota?.uncertain().catch(()=>{});}
  }
  private async beat(shard:Shard,pong?:Buffer):Promise<void>{
    // A beat already in flight covers this one; returning its promise would
    // hand a second fire-and-forget caller a rejection nobody handles.
    if(shard.heartbeat)return;
    const task=(async()=>{
      const socket=shard.socket,quota=shard.quota;if(this.stopped||!socket||socket.readyState!==WebSocket.OPEN||!quota)return;
      if(Date.now()-shard.lastMessageAt>STALE_AFTER_MS){await this.closeShard(shard);return;}
      const deadline=Date.now()+5000;await quota.renew(deadline);const permit=await quota.ping(deadline);
      if(this.stopped||shard.socket!==socket||socket.readyState!==WebSocket.OPEN)return;
      permit.dispatch(()=>{if(pong)socket.pong(pong);else socket.send(JSON.stringify({method:'ping'}));});
    })();shard.heartbeat=task;
    try{await task;}catch{await this.closeShard(shard);}finally{if(shard.heartbeat===task)shard.heartbeat=undefined;}
  }
  private open(shard:Shard):Promise<void>{
    if(shard.opening)return shard.opening;
    // An explicit open replaces a pending reconnect, so the timer can't open a second socket later.
    clearTimeout(shard.reconnectTimer);shard.reconnectTimer=undefined;
    const task=this.openSocket(shard);shard.opening=task;void task.finally(()=>{if(shard.opening===task)shard.opening=undefined;}).catch(()=>{});return task;
  }
  private async openSocket(shard:Shard):Promise<void>{
    if(this.stopped)return;if(!this.global)throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');
    const network=this.network(),reservation=await this.global.currentQuota().reserveSocket(Date.now()+5000,network);
    if(this.stopped){await reservation.connection.cancelBeforeConnect();return;}
    let socket:WebSocket|undefined;try{socket=reservation.connect.dispatch(()=>new WebSocket(this.config.value.hyperliquid.wsUrl,{autoPong:false,followRedirects:false,handshakeTimeout:5000,maxPayload:8*1024*1024}));reservation.connection.attach(socket);}catch(error){socket?.on('error',()=>{});socket?.terminate();await reservation.connection.cancelBeforeConnect().catch(()=>reservation.connection.uncertain().catch(()=>{}));throw error;}
    if(!socket)throw new LiveBoundaryError('trade_feed_source_mismatch');
    shard.socket=socket;shard.quota=reservation.connection;
    socket.on('open',()=>{void (async()=>{
      if(this.stopped||shard.socket!==socket){await this.closeShard(shard);return;}
      shard.attempt=0;shard.lastMessageAt=Date.now();await this.subscribe(shard,shard.coins);
      if(shard.connectedOnce&&shard.downSince!==null)this.handlers?.onGap(shard.downSince);
      shard.connectedOnce=true;shard.downSince=null;
      clearInterval(shard.pingTimer);shard.pingTimer=setInterval(()=>{void this.beat(shard);},PING_INTERVAL_MS);
    })().catch(()=>{void this.closeShard(shard);});});
    socket.on('ping',payload=>{void this.beat(shard,payload);});
    socket.on('message',data=>{shard.lastMessageAt=Date.now();try{this.handleMessage(data.toString());}catch(error){this.logger.warn(`Trade feed message skipped: ${error instanceof Error?error.message.slice(0,160):'unknown'}`);}});
    socket.on('error',()=>{this.logger.error('Trade feed socket unavailable');});
    socket.on('close',()=>{
      clearInterval(shard.pingTimer);if(this.stopped||shard.socket!==socket)return;
      shard.socket=undefined;shard.downSince??=Date.now();this.scheduleReconnect(shard);
    });
  }
  /** Backoff reconnect. A failed open (no admission, no socket) schedules the
   * next attempt instead of leaving the shard's markets unwatched until the
   * hourly market refresh. */
  private scheduleReconnect(shard:Shard):void{
    if(this.stopped)return;clearTimeout(shard.reconnectTimer);
    const delay=Math.min(MAX_RECONNECT_DELAY_MS,1000*2**shard.attempt);shard.attempt++;
    shard.reconnectTimer=setTimeout(()=>{shard.reconnectTimer=undefined;void this.open(shard).catch(()=>{shard.downSince??=Date.now();this.logger.warn('Trade feed global admission unavailable; retrying');this.scheduleReconnect(shard);});},delay);
  }
  private async subscribe(shard:Shard,coins:string[]):Promise<void>{
    const socket=shard.socket,quota=shard.quota;if(!quota||!socket)throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');
    const subscriptions=coins.map(coin=>quotaSubscription(this.network(),{type:'trades',coin})),deadline=Date.now()+5000;
    await quota.whenIdle();await quota.renew(deadline);const permit=await quota.subscribe(subscriptions,deadline,false);
    if(this.stopped||shard.socket!==socket)return;
    for(const sub of subscriptions)permit.dispatch({method:'subscribe',subscription:sub.subscription},captured=>socket.send(JSON.stringify(captured)));
  }
}
