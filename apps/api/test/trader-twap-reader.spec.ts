import {describe,it,expect,vi} from 'vitest';
const sockets=vi.hoisted(()=>({all:[] as any[],script:undefined as undefined|((socket:any,command:any)=>void)}));
vi.mock('ws',async()=>{
 const {EventEmitter}=await import('node:events');
 class Socket extends EventEmitter {
  static OPEN=1;static CLOSED=3;readyState=0;url:string;
  constructor(url:string,readonly options:unknown){super();this.url=url;sockets.all.push(this);queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
  send(raw:string){sockets.script?.(this,JSON.parse(raw));}
  close(code:number){this.readyState=3;queueMicrotask(()=>this.emit('close',code));}
  terminate(){this.readyState=3;queueMicrotask(()=>this.emit('close',1006));}
 }
 return {default:Socket};
});
import {HyperliquidGlobalTransport} from '../src/hyperliquid/hyperliquid-global-transport.js';
import {TraderTwapReader,parseTwapSnapshot} from '../src/traders/trader-twap-reader.js';
const user='0x'+'1'.repeat(40);
const entry={time:1750000000,twapId:17,state:{coin:'BTC',side:'B',sz:'1',executedSz:'0.2',executedNtl:'20000',minutes:30,reduceOnly:false,randomize:true,timestamp:1750000000000},status:{status:'activated'}};
const snapshot=(history:unknown[]=[entry])=>({channel:'userTwapHistory',data:{user,isSnapshot:true,history}});
function harness(){
 const idle=vi.fn(async()=>{}),uncertain=vi.fn(async()=>{}),dispatch=vi.fn((command:any,work:any)=>work(command));
 const connection={cancelBeforeConnect:vi.fn(async()=>{}),attach:vi.fn(),ping:vi.fn(async()=>({assertFresh:()=>{},dispatch:(work:any)=>work()})),renew:vi.fn(),close:vi.fn(async()=>{sockets.all[0].close(1000);}),subscribe:vi.fn(async()=>({dispatch})),unsubscribe:vi.fn(async()=>({dispatch})),whenIdle:idle,uncertain};
 const reserveSocket=vi.fn(async()=>({connect:{assertFresh:()=>{},dispatch:(work:any)=>work()},connection}));
 const transport=Object.create(HyperliquidGlobalTransport.prototype) as HyperliquidGlobalTransport;
 vi.spyOn(transport,'isOriginal').mockReturnValue(false);
 vi.spyOn(transport,'currentQuota').mockReturnValue({reserveSocket,acquireRest:vi.fn()});
 sockets.all.length=0;
 sockets.script=(socket,command)=>queueMicrotask(()=>{
  socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})),false);
  if(command.method==='subscribe')socket.emit('message',Buffer.from(JSON.stringify(snapshot())),false);
 });
 return {reader:new TraderTwapReader(transport,'mainnet',{timeoutMs:200,cleanupTimeoutMs:100}),connection,reserveSocket,idle,transport};
}
describe('TWAP snapshot parsing',()=>{
 it('preserves source timestamps and only claims provider snapshot coverage',()=>{
  const parsed=parseTwapSnapshot(snapshot(),user,1750001000000);
  expect(parsed.observedAt).toBe(1750001000000);
  expect(parsed.history).toEqual([entry]);expect(parsed.sourceTime).toBe(1750000000000);expect(parsed.coverage).toBe('provider_snapshot');
 });
 it('accepts an actually empty snapshot with no invented source timestamp',()=>expect(parseTwapSnapshot(snapshot([]),user).sourceTime).toBeNull());
 it.each([
  {...snapshot(),data:{...snapshot().data,isSnapshot:false}},
  {...snapshot(),data:{...snapshot().data,user:'0x'+'2'.repeat(40)}},
  {...snapshot(),data:{...snapshot().data,history:[{...entry,state:{...entry.state,sz:'NaN'}}]}},
  {...snapshot(),data:{...snapshot().data,history:Array.from({length:100001},()=>entry)}},
 ])('rejects non-snapshots, foreign users, invalid rows and oversized history',(value)=>expect(()=>parseTwapSnapshot(value,user)).toThrow());
});
describe('bounded concrete TWAP reader',()=>{
 it('reserves socket and subscription, requires actual snapshot and unsubscribe ACK before idle/close',async()=>{
  const h=harness(),result=await h.reader.read(user);
  expect(result.history).toEqual([entry]);expect(h.reserveSocket).toHaveBeenCalledWith(expect.any(Number),'mainnet');
  expect(sockets.all[0].url).toBe('wss://api.hyperliquid.xyz/ws');expect(sockets.all[0].options).toMatchObject({maxPayload:8*1024*1024,followRedirects:false,autoPong:false});
  expect(h.connection.attach).toHaveBeenCalledWith(sockets.all[0]);expect(h.connection.subscribe).toHaveBeenCalledWith(expect.any(Array),expect.any(Number),true,false);
  expect(h.idle).toHaveBeenCalled();expect(sockets.all[0].readyState).toBe(1);
  await h.reader.read(user);expect(h.reserveSocket).toHaveBeenCalledTimes(1);expect(h.connection.renew).toHaveBeenCalled();
  await h.reader.onModuleDestroy();expect(sockets.all[0].readyState).toBe(3);
 });
 it('fails without a snapshot and closes the socket',async()=>{
  const h=harness();sockets.script=(socket,command)=>queueMicrotask(()=>socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})),false));
  await expect(h.reader.read(user)).rejects.toThrow();expect(sockets.all[0].readyState).toBe(3);
 });
 it('rejects absent unsubscribe ACK rather than claiming cleanup',async()=>{
  const h=harness();sockets.script=(socket,command)=>{if(command.method==='subscribe')queueMicrotask(()=>{socket.emit('message',Buffer.from(JSON.stringify({channel:'subscriptionResponse',data:command})),false);socket.emit('message',Buffer.from(JSON.stringify(snapshot())),false);});};
  await expect(h.reader.read(user)).rejects.toThrow();expect(sockets.all[0].readyState).toBe(3);
 });
 it.each(['binary','malformed','foreign','incremental','oversized','unsolicited_unsubscribe'])('rejects %s frames and aborts without claiming cleanup',async(kind)=>{
  const h=harness();sockets.script=(socket,command)=>{
   if(command.method!=='subscribe')return;
   queueMicrotask(()=>{
    let data:unknown=snapshot(),binary=false;
    if(kind==='foreign')data={...snapshot(),data:{...snapshot().data,user:'0x'+'2'.repeat(40)}};
    if(kind==='incremental')data={...snapshot(),data:{...snapshot().data,isSnapshot:false}};
    if(kind==='unsolicited_unsubscribe')data={channel:'subscriptionResponse',data:{method:'unsubscribe',subscription:command.subscription}};
    if(kind==='binary')binary=true;
    const text=kind==='malformed'?'bad json':kind==='oversized'?' '.repeat(8*1024*1024+1):JSON.stringify(data);
    socket.emit('message',Buffer.from(text),binary);
   });
  };
  await expect(h.reader.read(user)).rejects.toThrow();expect(h.connection.uncertain).toHaveBeenCalled();expect(h.connection.close).not.toHaveBeenCalled();
 });
 it('does not return data when quota ACK persistence fails',async()=>{
  const h=harness();h.idle.mockRejectedValue(new Error('database unavailable'));
  await expect(h.reader.read(user)).rejects.toThrow();expect(h.connection.uncertain).toHaveBeenCalled();
 });
 it('retains genuine snapshot success when later shutdown receives abnormal close',async()=>{
  const h=harness();const result=await h.reader.read(user);expect(result.history).toEqual([entry]);
  h.connection.close.mockRejectedValue(new Error('peer1006'));
  await expect(h.reader.onModuleDestroy()).rejects.toThrow();expect(h.connection.uncertain).toHaveBeenCalled();
 });
 it('keeps the original receipt timestamp through delayed cleanup',async()=>{
  const h=harness();let cleanupStarted=0;
  h.idle.mockImplementation(async()=>{cleanupStarted=Date.now();await new Promise(resolve=>setTimeout(resolve,15));});
  const result=await h.reader.read(user);
  expect(result.observedAt).toBeLessThanOrEqual(cleanupStarted);expect(result.observedAt).toBeLessThan(Date.now());
 });
 it('rejects wall clock rollback instead of returning misleading freshness',async()=>{
  const h=harness(),realNow=Date.now.bind(Date);let rollback=false;
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>realNow()-(rollback?2000:0));
  h.idle.mockImplementation(async()=>{rollback=true;});
  try{await expect(h.reader.read(user)).rejects.toThrow();}finally{clock.mockRestore();}
 });
 it('renews idle leases and meters heartbeat, retaining uncertainty on missing pong',async()=>{
  let tick!:()=>void;const interval=vi.spyOn(globalThis,'setInterval').mockImplementation(((callback:()=>void)=>{tick=callback;return {unref:()=>{}};}) as any);
  try{
   const h=harness();await h.reader.read(user);sockets.script=()=>{};
   tick();await new Promise(resolve=>setTimeout(resolve,5));
   expect(h.connection.renew).toHaveBeenCalled();expect(h.connection.ping).toHaveBeenCalledOnce();
   tick();await new Promise(resolve=>setTimeout(resolve,5));expect(h.connection.uncertain).toHaveBeenCalled();expect(sockets.all[0].readyState).toBe(3);
  }finally{interval.mockRestore();}
 });
 it('does not accumulate per-read listeners or overlap user subscriptions',async()=>{
  const h=harness();await Promise.all([h.reader.read(user),h.reader.read(user)]);
  for(let i=0;i<12;i++)await h.reader.read(user);
  expect(h.reserveSocket).toHaveBeenCalledOnce();expect(sockets.all[0].listenerCount('message')).toBe(1);expect(sockets.all[0].listenerCount('close')).toBe(1);
  await h.reader.onModuleDestroy();
 });
 it('rejects original financial context before any public quota reservation',async()=>{
  const h=harness();vi.spyOn(h.transport,'isOriginal').mockReturnValue(true);
  await expect(h.reader.read(user)).rejects.toThrow();expect(h.reserveSocket).not.toHaveBeenCalled();
 });
 it('never opens a late reserved socket after shutdown has started',async()=>{
  const h=harness();let deliver!:(value:any)=>void;
  h.reserveSocket.mockImplementation(()=>new Promise(resolve=>{deliver=resolve;}));
  const reading=h.reader.read(user);void reading.catch(()=>{});await new Promise(resolve=>setTimeout(resolve,1));
  const stopping=h.reader.onModuleDestroy();void stopping.catch(()=>{});
  deliver({connect:{assertFresh:()=>{},dispatch:(work:any)=>work()},connection:h.connection});
  await expect(reading).rejects.toThrow();await stopping;expect(sockets.all).toHaveLength(0);expect(h.connection.cancelBeforeConnect).toHaveBeenCalledOnce();expect(h.connection.uncertain).not.toHaveBeenCalled();
 });
 it('retains uncertainty when attachment fails after construction and private cancellation rejects',async()=>{
  const h=harness();h.connection.attach.mockImplementation(()=>{throw Error('attach failed');});h.connection.cancelBeforeConnect.mockRejectedValue(new Error('already dispatched'));
  await expect(h.reader.read(user)).rejects.toThrow();expect(h.connection.cancelBeforeConnect).toHaveBeenCalled();expect(h.connection.uncertain).toHaveBeenCalled();
 });
 it('never constructs a socket when quota reservation fails',async()=>{
  const h=harness();h.reserveSocket.mockRejectedValue(new Error('quota full'));
  await expect(h.reader.read(user)).rejects.toThrow();expect(sockets.all).toHaveLength(0);
 });
 it('rejects structural transport and unsafe user/network before dispatch',async()=>{
  expect(()=>new TraderTwapReader({} as HyperliquidGlobalTransport,'mainnet')).toThrow();
  expect(()=>new TraderTwapReader(Object.create(HyperliquidGlobalTransport.prototype),'mainnet',{infoUrl:'https://evil.test/info'})).toThrow();
  const h=harness();await expect(h.reader.read('../bad')).rejects.toThrow();expect(h.reserveSocket).not.toHaveBeenCalled();
 });
});
