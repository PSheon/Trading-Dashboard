import WebSocket from 'ws';
import { z } from 'zod';
import { MAX_LIVE_PERP_DEXES, LIVE_DEX_NAME } from './live-market-resolver.js';
import { address, LiveBoundaryError } from './wallet-authorization.js';

export interface LiveAllDexsStateEvidence {
  readonly network: 'testnet'; readonly accountAddress: string; readonly observedAt: number; readonly data: unknown;
}
export interface LiveOrderVenueEvidence {
  readonly dex: string; readonly user: string; readonly observedAt: number; readonly receivedAt: number; readonly orders: readonly unknown[];
}
export interface LiveAllDexsOrderEvidence {
  readonly network: 'testnet'; readonly accountAddress: string; readonly observedAt: number; readonly completedAt: number;
  readonly requestedDexes: readonly string[]; readonly venues: readonly LiveOrderVenueEvidence[];
}
export interface LiveAllDexsAccountEvidence {
  readonly state: LiveAllDexsStateEvidence; readonly orders: LiveAllDexsOrderEvidence;
}
export interface LiveAllDexsAccountSource {
  read(accountAddress: string, timeoutMs: number): Promise<LiveAllDexsStateEvidence>;
  readOrders?(accountAddress: string, dexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsOrderEvidence>;
  readAccount?(accountAddress: string, dexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsAccountEvidence>;
  close?(): void;
}
const BATCH = 90, MESSAGE_LIMIT = 1800, WINDOW = 60_000, MIN_ORDER_INTERVAL = 1000;
const dexList = z.array(z.string().max(40).refine((v) => v === '' || LIVE_DEX_NAME.test(v))).min(1).max(MAX_LIVE_PERP_DEXES);
const fail = (code: string): never => { throw new LiveBoundaryError(code); };

/** Official fixed-testnet snapshot subscriptions. One reusable socket; bounded
 * batches and rolling command admission include cleanup before any sends. */
export class HyperliquidAllDexsAccountSource implements LiveAllDexsAccountSource {
  private socket?: WebSocket;
  private busy = false;
  private readonly sentReservations: number[] = [];
  private readonly connections: number[] = [];
  private lastOrderAttempt?: number;
  constructor(private readonly now = Date.now,
    private readonly createSocket = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options)) {}

  private reserve(count: number): void {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail('live_account_source_time_invalid');
    while (this.sentReservations.length && this.sentReservations[0]! <= now - WINDOW) this.sentReservations.shift();
    if (this.sentReservations.length + count > MESSAGE_LIMIT) fail('live_account_ws_message_budget');
    for (let i = 0; i < count; i++) this.sentReservations.push(now);
  }
  private connection(timeoutMs: number): WebSocket {
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) {
      const now = this.now();
      while (this.connections.length && this.connections[0]! <= now - WINDOW) this.connections.shift();
      if (this.connections.length >= 25) fail('live_account_ws_connection_budget');
      this.connections.push(now);
      const created = this.createSocket('wss://api.hyperliquid-testnet.xyz/ws', {
        maxPayload: 8 * 1024 * 1024, handshakeTimeout: timeoutMs, followRedirects: false,
      });
      this.socket = created;
      created.on('error', () => { if (this.socket === created) this.socket = undefined; });
      created.on('close', () => { if (this.socket === created) this.socket = undefined; });
    }
    return this.socket;
  }
  private admit(timeoutMs: number): void {
    if (this.busy || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) fail('live_account_aggregate_unavailable');
  }

  async read(accountAddress: string, timeoutMs: number): Promise<LiveAllDexsStateEvidence> {
    const user = address(accountAddress), observedAt = this.now();
    this.admit(timeoutMs); this.reserve(2); this.busy = true;
    let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let open: (() => void) | undefined, message: ((raw: WebSocket.RawData) => void) | undefined, unavailable: (() => void) | undefined;
    let succeeded = false;
    try {
      socket = this.connection(timeoutMs);
      const result = await new Promise<LiveAllDexsStateEvidence>((resolve, reject) => {
        const deny = (code = 'live_account_aggregate_unavailable') => reject(new LiveBoundaryError(code));
        let acknowledged = false, phase: 'subscribe' | 'unsubscribe' = 'subscribe', bytes = 0, frames = 0;
        let evidence: LiveAllDexsStateEvidence | undefined;
        open = () => { try { socket!.send(JSON.stringify({ method: 'subscribe',
          subscription: { type: 'allDexsClearinghouseState', user } })); } catch { deny(); } };
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
            evidence = { network: 'testnet', accountAddress: user, observedAt, data: payload.data };
            phase = 'unsubscribe'; socket!.send(JSON.stringify({ method: 'unsubscribe', subscription: { type: 'allDexsClearinghouseState', user } }));
          } catch { deny(); }
        };
        unavailable = () => deny();
        socket!.on('open', open); socket!.on('message', message); socket!.on('error', unavailable); socket!.on('close', unavailable);
        timer = setTimeout(() => { deny(); socket?.terminate(); }, timeoutMs);
        if (socket!.readyState === WebSocket.OPEN) open();
      });
      succeeded = true; return result;
    } finally {
      clearTimeout(timer);
      if (socket) {
        if (open) socket.off('open', open); if (message) socket.off('message', message);
        if (unavailable) { socket.off('error', unavailable); socket.off('close', unavailable); }
        if (!succeeded) { socket.terminate(); if (this.socket === socket) this.socket = undefined; }
      }
      this.busy = false;
    }
  }

  async readOrders(accountAddress: string, requestedDexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsOrderEvidence> {
    return (await this.readSnapshots(accountAddress, requestedDexes, timeoutMs, false)).orders;
  }
  async readAccount(accountAddress: string, requestedDexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsAccountEvidence> {
    const result = await this.readSnapshots(accountAddress, requestedDexes, timeoutMs, true);
    if (!result.state) throw new LiveBoundaryError('live_account_aggregate_unavailable');
    return { state: result.state, orders: result.orders };
  }
  private async readSnapshots(accountAddress: string, requestedDexes: readonly string[], timeoutMs: number, includeState: boolean):
    Promise<{ state?: LiveAllDexsStateEvidence; orders: LiveAllDexsOrderEvidence }> {
    const user = address(accountAddress), observedAt = this.now(), dexes = dexList.parse([...requestedDexes]);
    if (new Set(dexes).size !== dexes.length) fail('live_account_duplicate_evidence');
    this.admit(timeoutMs);
    if (this.lastOrderAttempt !== undefined && observedAt - this.lastOrderAttempt < MIN_ORDER_INTERVAL) fail('live_account_orders_throttled');
    this.reserve(2 * dexes.length + (includeState ? 2 : 0)); this.lastOrderAttempt = observedAt; this.busy = true;
    let socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let open: (() => void) | undefined, message: ((raw: WebSocket.RawData) => void) | undefined, unavailable: (() => void) | undefined;
    let succeeded = false;
    try {
      socket = this.connection(timeoutMs);
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
          try { socket!.send(JSON.stringify({ method, subscription: { type: 'allDexsClearinghouseState', user } })); }
          catch { deny(); }
        };
        const send = (method: 'subscribe' | 'unsubscribe', dex: string) => {
          if (stopped) return;
          try { socket!.send(JSON.stringify({ method, subscription: { type: 'openOrders', user, dex } })); }
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
            phase = 'unsubscribe'; pending = new Set(batch); for (const dex of batch) send('unsubscribe', dex);
          } else if (phase === 'unsubscribe' && pending.size === 0 && statePhase === 'done') {
            if (offset < dexes.length) next();
            else resolve({ state, orders: { network: 'testnet', accountAddress: user, observedAt, completedAt: this.now(),
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
              state = { network: 'testnet', accountAddress: user, observedAt, data: payload.data };
              statePhase = 'unsubscribe'; sendState('unsubscribe');
            } else if (payload.channel === 'openOrders') {
              const row = payload.data;
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
        socket!.on('open', open); socket!.on('message', message); socket!.on('error', unavailable); socket!.on('close', unavailable);
        timer = setTimeout(() => deny('live_account_orders_deadline_exceeded'), timeoutMs);
        if (socket!.readyState === WebSocket.OPEN) open();
      });
      succeeded = true; return result;
    } finally {
      clearTimeout(timer);
      if (socket) {
        if (open) socket.off('open', open); if (message) socket.off('message', message);
        if (unavailable) { socket.off('error', unavailable); socket.off('close', unavailable); }
        // Failed scans cannot leave unknown subscriptions/acks on a reusable
        // connection; successful scans waited for every unsubscribe ack.
        if (!succeeded) { socket.terminate(); if (this.socket === socket) this.socket = undefined; }
      }
      this.busy = false;
    }
  }
  close(): void { this.socket?.terminate(); this.socket = undefined; }
}
