import { testConfig } from "./config-test-utils.js";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';
import { quotaSubscription } from '../src/hyperliquid/hyperliquid-global-quota.js';
import type { HyperliquidSocketQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import type { HlWsTrade } from "../src/hyperliquid/types.js";
import { TradeFeedService } from "../src/watcher/trade-feed.service.js";

const local = vi.hoisted(()=>({url:''}));
vi.mock('ws',async(importOriginal)=>{const actual=await importOriginal<typeof import('ws')>();return {...actual,WebSocket:class extends actual.WebSocket {constructor(url:string,options?:import('ws').ClientOptions){expect(url).toBe('wss://api.hyperliquid.xyz/ws');expect(options?.autoPong).toBe(false);super(local.url,options);}}};});
function globalFixture(){
 const meter=new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
 const handles:HyperliquidSocketQuota[]=[];
 const reserve=vi.fn(async()=>{
  let socket:WebSocket|undefined;
  const connection:HyperliquidSocketQuota={cancelBeforeConnect:vi.fn(async()=>{}),attach:s=>{socket=s;},subscribe:vi.fn<HyperliquidSocketQuota["subscribe"]>(async(subs)=>{const bodies=subs.map(s=>({method:'subscribe',subscription:s.subscription}));return {dispatch:(body,work)=>{const i=bodies.findIndex(b=>JSON.stringify(b)===JSON.stringify(body));if(i<0)throw Error('wrong command');return work(Object.freeze(bodies.splice(i,1)[0]!));}};}),unsubscribe:vi.fn(),ping:vi.fn<HyperliquidSocketQuota["ping"]>(async()=>({assertFresh:()=>{},dispatch:work=>work()})),renew:vi.fn(async()=>{}),uncertain:vi.fn(async()=>{}),whenIdle:vi.fn(async()=>{}),close:vi.fn(async()=>{if(!socket)return;await new Promise<void>(r=>{socket!.once('close',()=>r());socket!.close(1000);});})};
  handles.push(connection);let used=false;return {connect:{assertFresh:()=>{},dispatch:<T>(work:()=>T):T=>{if(used)throw Error('reuse');used=true;return work();}},connection};
 });
 vi.spyOn(meter,'bindUnscoped').mockReturnValue({acquireRest:vi.fn(),reserveSocket:reserve});
 return {transport:new HyperliquidGlobalTransport(meter,{egressKey:'explicit-test-shared-egress',ownerId:'test-watcher'}),reserve,handles};
}
/** A local stand-in for wss://api.hyperliquid.xyz/ws. */
async function fakeHyperliquid() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const subscriptions: string[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { method: string; subscription?: { coin: string } };
      if (message.method === "subscribe") subscriptions.push(message.subscription!.coin);
    });
  });
  return { server, subscriptions, sockets, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const markets = (main: string[], xyz: string[]) =>
  ({
    perpDexs: vi.fn(async () => [null, { name: "xyz" }]),
    allPerpMetas: vi.fn(async()=>[main,xyz].map(coins=>({universe:coins.map(name=>({name,szDecimals:1,maxLeverage:10}))}))),
    meta: vi.fn(async (dex?: string) => ({
      universe: (dex === "xyz" ? xyz : main).map((name) => ({ name, szDecimals: 1, maxLeverage: 10 })),
    })),
  }) as unknown as HyperliquidInfoClient;

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("TradeFeedService — against a local WebSocket server", () => {
  let feed: TradeFeedService | undefined;
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    await feed?.stop();
    server?.close();
  });

  it("subscribes to every listed market on every dex and reports watched counterparties", async () => {
    const fake = await fakeHyperliquid();
    server = fake.server;
    local.url=fake.url;process.env.HYPERLIQUID_WS_URL="wss://api.hyperliquid.xyz/ws";
    const seen: Array<[string, number]> = [];
    feed = new TradeFeedService(testConfig(), markets(["BTC", "ETH"], ["xyz:TSLA"]),globalFixture().transport);
    feed.setWatched(["0xAbC"]);
    await feed.start({ onTrade: (a, t) => seen.push([a, t.tid]), onGap: () => {} });

    await until(() => fake.subscriptions.length === 3);
    expect(fake.subscriptions.sort()).toEqual(["BTC", "ETH", "xyz:TSLA"]);

    const now = Date.now();
    const trades: HlWsTrade[] = [
      { coin: "BTC", side: "B", px: "1", sz: "1", time: now, hash: "0x", tid: 7, users: ["0xabc", "0xother"] },
      { coin: "BTC", side: "B", px: "1", sz: "1", time: now, hash: "0x", tid: 8, users: ["0xnope", "0xother"] },
      // Replayed on subscribe: too old to mean "just traded".
      { coin: "BTC", side: "B", px: "1", sz: "1", time: now - 5 * 60_000, hash: "0x", tid: 9, users: ["0xabc", "0xother"] },
    ];
    fake.sockets[0].send(JSON.stringify({ channel: "trades", data: trades }));
    await until(() => seen.length === 1);
    expect(seen).toEqual([["0xabc", 7]]);
    expect(feed.status()).toMatchObject({ socketsOpen: 1, socketsTotal: 1, markets: 3, disconnectedSince: null });
  });

  it("reconnects after a drop, resubscribes, and reports the gap", async () => {
    const fake = await fakeHyperliquid();
    server = fake.server;
    local.url=fake.url;process.env.HYPERLIQUID_WS_URL="wss://api.hyperliquid.xyz/ws";
    const gaps: number[] = [];
    feed = new TradeFeedService(testConfig(), markets(["BTC"], []),globalFixture().transport);
    await feed.start({ onTrade: () => {}, onGap: (since) => gaps.push(since) });
    await until(() => fake.subscriptions.length === 1);

    const droppedAt = Date.now();
    fake.sockets[0].terminate();
    await until(() => feed!.status().disconnectedSince !== null);
    await until(() => fake.subscriptions.length === 2, 5000);
    await until(() => gaps.length === 1);

    expect(gaps[0]).toBeGreaterThanOrEqual(droppedAt - 50);
    expect(feed.status()).toMatchObject({ socketsOpen: 1, disconnectedSince: null });
  });

  it("spreads markets over sockets of at most 200 subscriptions", async () => {
    const fake = await fakeHyperliquid();
    server = fake.server;
    local.url=fake.url;process.env.HYPERLIQUID_WS_URL="wss://api.hyperliquid.xyz/ws";
    const main = Array.from({ length: 250 }, (_, i) => `C${i}`);
    feed = new TradeFeedService(testConfig(), markets(main, ["xyz:A"]),globalFixture().transport);
    await feed.start({ onTrade: () => {}, onGap: () => {} });
    await until(() => fake.subscriptions.length === 251);
    expect(fake.sockets).toHaveLength(2);
    expect(feed.status()).toMatchObject({ socketsTotal: 2, markets: 251 });
  });
  it('denies startup when a shared-egress transport is absent rather than creating a raw socket',async()=>{
    feed=new TradeFeedService(testConfig(),markets(['BTC'],[]));await expect(feed.start({onTrade:()=>{},onGap:()=>{}})).rejects.toThrow('hyperliquid_quota_egress_unconfigured');
  });
  it('honors global connection denial and finite subscribe dispatch, then awaits graceful quota close',async()=>{
    const fake=await fakeHyperliquid();server=fake.server;local.url=fake.url;process.env.HYPERLIQUID_WS_URL='wss://api.hyperliquid.xyz/ws';
    const global=globalFixture();global.reserve.mockRejectedValueOnce(Error('global exhausted'));
    feed=new TradeFeedService(testConfig(),markets(['BTC'],[]),global.transport);await expect(feed.start({onTrade:()=>{},onGap:()=>{}})).rejects.toThrow('global exhausted');expect(fake.sockets).toHaveLength(0);
    await feed.start({onTrade:()=>{},onGap:()=>{}});await until(()=>fake.subscriptions.length===1);
    expect(global.handles[0]!.subscribe).toHaveBeenCalledWith([quotaSubscription('mainnet',{type:'trades',coin:'BTC'})],expect.any(Number),false);
    await feed.stop();expect(global.handles[0]!.close).toHaveBeenCalledOnce();expect(global.handles[0]!.whenIdle).toHaveBeenCalled();
  });

  it('meters native pong explicitly after lease renewal instead of automatically replying',async()=>{
    const fake=await fakeHyperliquid();server=fake.server;local.url=fake.url;process.env.HYPERLIQUID_WS_URL='wss://api.hyperliquid.xyz/ws';const global=globalFixture();
    feed=new TradeFeedService(testConfig(),markets(['BTC'],[]),global.transport);await feed.start({onTrade:()=>{},onGap:()=>{}});await until(()=>fake.subscriptions.length===1);
    let pongs=0;fake.sockets[0]!.on('pong',()=>{pongs++;});fake.sockets[0]!.ping(Buffer.from('quota-native-ping'));await until(()=>pongs===1);
    const handle=global.handles[0]!;expect(handle.ping).toHaveBeenCalledOnce();expect(handle.renew).toHaveBeenCalledTimes(2);expect(vi.mocked(handle.renew).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(handle.ping).mock.invocationCallOrder[0]!);
  });
  it('emits no subscription after a finite dispatch permit has expired',async()=>{
    const fake=await fakeHyperliquid();server=fake.server;local.url=fake.url;process.env.HYPERLIQUID_WS_URL='wss://api.hyperliquid.xyz/ws';const global=globalFixture(),original=global.reserve.getMockImplementation()!;
    global.reserve.mockImplementationOnce(async()=>{const result=await original();vi.mocked(result.connection.subscribe).mockResolvedValueOnce({dispatch:()=>{throw Error('expired');}});return result;});
    feed=new TradeFeedService(testConfig(),markets(['BTC'],[]),global.transport);await feed.start({onTrade:()=>{},onGap:()=>{}});await until(()=>global.handles[0]&&vi.mocked(global.handles[0].close).mock.calls.length===1);
    expect(fake.subscriptions).toEqual([]);expect(feed.status().disconnectedSince).not.toBeNull();
  });
  it('loads hundreds of opaque venues in two bounded catalog reads and rejects duplicate identities',async()=>{
    const dexes=[null,...Array.from({length:267},(_,i)=>({name:i===2?'i<3fl':`venue${i}`}))],metas=dexes.map(row=>({universe:[{name:row?`${row.name}:ASSET`:'BTC',szDecimals:2,maxLeverage:10}]}));
    const info={perpDexs:vi.fn(async()=>dexes),allPerpMetas:vi.fn(async()=>metas)} as unknown as HyperliquidInfoClient;
    feed=new TradeFeedService(testConfig(),info);expect(await feed.listMarkets()).toHaveLength(268);expect(info.perpDexs).toHaveBeenCalledOnce();expect(info.allPerpMetas).toHaveBeenCalledOnce();
    dexes[3]=dexes[2]!;await expect(feed.listMarkets()).rejects.toThrow('trade_feed_market_identity_invalid');
  });

  it('keeps module shutdown pending when an earlier caller started graceful stop without awaiting it',async()=>{
    const fake=await fakeHyperliquid();server=fake.server;local.url=fake.url;process.env.HYPERLIQUID_WS_URL='wss://api.hyperliquid.xyz/ws';const global=globalFixture();
    feed=new TradeFeedService(testConfig(),markets(['BTC'],[]),global.transport);await feed.start({onTrade:()=>{},onGap:()=>{}});await until(()=>fake.subscriptions.length===1);
    const handle=global.handles[0]!,close=vi.mocked(handle.close).getMockImplementation()!;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});vi.mocked(handle.close).mockImplementationOnce(async deadline=>{await gate;return close(deadline);});
    const first=feed.stop();let complete=false;const shutdown=feed.onModuleDestroy().then(()=>{complete=true;});
    try{await new Promise(r=>setTimeout(r,10));expect(complete).toBe(false);}finally{release();await first;await shutdown;}
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('uses private unsent cancellation when stopped while a connection reservation is awaiting SQL',async()=>{
    const fake=await fakeHyperliquid();server=fake.server;local.url=fake.url;process.env.HYPERLIQUID_WS_URL='wss://api.hyperliquid.xyz/ws';const global=globalFixture(),original=global.reserve.getMockImplementation()!;
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});global.reserve.mockImplementationOnce(async()=>{entered();await gate;return original();});
    feed=new TradeFeedService(testConfig(),markets(['BTC'],[]),global.transport);const starting=feed.start({onTrade:()=>{},onGap:()=>{}});await started;
    const stopping=feed.stop();release();await starting;await stopping;expect(fake.sockets).toEqual([]);expect(global.handles[0]!.cancelBeforeConnect).toHaveBeenCalledOnce();expect(global.handles[0]!.uncertain).not.toHaveBeenCalled();
  });

});
