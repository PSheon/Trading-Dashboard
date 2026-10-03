import type { OnModuleDestroy } from '@nestjs/common';
import { z } from 'zod';
import { Dec } from '../common/decimal/dec.js';
import { readInfoJson } from '../hyperliquid/response-validation.js';
import { HyperliquidAllDexsAccountSource, type LiveAllDexsAccountSource } from './live/live-account-ws-source.js';
import { boundedLiveRead, LIVE_DEX_NAME, MAX_LIVE_PERP_DEXES } from './live/live-market-resolver.js';
import { address, LiveBoundaryError } from './live/wallet-authorization.js';
import { accountModeDigest } from './copy-account-mode.repository.js';
import type { AccountModeAbsenceProof, AccountModeAbsenceReader } from './copy-account-mode.service.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
const zero = decimal.refine(v => Dec.from(v).eq(0));
const summary = z.object({ accountValue: decimal, totalRawUsd: decimal, totalNtlPos: zero, totalMarginUsed: zero });
const stateSchema = z.object({ marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: zero,
  withdrawable: decimal, time: integer, assetPositions: z.array(z.unknown()).max(0) });
const dexSchema = z.array(z.object({ name: z.string().regex(LIVE_DEX_NAME).max(40) }).nullable()).min(1).max(MAX_LIVE_PERP_DEXES);
const fail = (): never => { throw new LiveBoundaryError('account_mode_absence_unproven'); };
function unique(values: readonly string[]) { if (new Set(values).size !== values.length) fail(); }
function fresh(at: number, now: number) { if (!Number.isSafeInteger(at) || at <= 0 || at > now || now - at > 5000) fail(); }

/** Bootstrap evidence proves empty exposure only; default balances never
 * become standard equity/margin. Every actual perp venue must be observed. */
export class HyperliquidAccountModeAbsenceReader implements AccountModeAbsenceReader, OnModuleDestroy {
  private readonly source: LiveAllDexsAccountSource;
  constructor(private readonly acquire: (weight: number) => Promise<unknown>, private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now, source?: LiveAllDexsAccountSource) {
    this.source = source ?? new HyperliquidAllDexsAccountSource(now);
  }
  onModuleDestroy() { this.source.close?.(); }
  async prove(accountAddress: string): Promise<Readonly<AccountModeAbsenceProof>> {
    try {
      const user = address(accountAddress), started = this.now(); fresh(started, started);
      const readAccount = this.source.readAccount;
      if (!readAccount) return fail();
      const remaining = () => { fresh(started, this.now()); return Math.max(1, 5000 - (this.now() - started)); };
      const read = async (type: string, weight: number, accountScoped = false) => {
        const body = { type, ...(accountScoped ? { user } : {}) };
        await boundedLiveRead(this.acquire(weight), remaining());
        const response = await boundedLiveRead(this.fetcher('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(remaining()) }), remaining());
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); fail(); }
        const value = await boundedLiveRead(readInfoJson(response, 'mode absence evidence', 2 * 1024 * 1024), remaining());
        fresh(started, this.now());
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row.user !== undefined && (typeof row.user !== 'string' || address(row.user) !== user) || row.network !== undefined && row.network !== 'testnet') fail();
        }
        return value;
      };
      const [rawDexes, spot, agents] = await Promise.all([read('perpDexs', 20), read('spotClearinghouseState', 2, true), read('extraAgents', 20, true)]);
      const list = dexSchema.parse(rawDexes);
      if (list[0] !== null) fail();
      const dexes = ['', ...list.flatMap(row => row ? [row.name] : [])]; unique(dexes);
      // Existing arbitrary agent authority and spot-held collateral are outside
      // the newly dedicated dormant bootstrap this action is allowed to change.
      z.array(z.unknown()).max(0).parse(agents);
      const balances = z.object({ portfolioMarginEnabled: z.literal(false).optional(), balances: z.array(z.object({
        coin: z.string().min(1).max(80), token: integer, total: zero, hold: zero,
      })).max(10000) }).parse(spot).balances;
      unique(balances.map(b => String(b.token))); unique(balances.map(b => b.coin));
      await boundedLiveRead(this.acquire(40), remaining());
      const proof = structuredClone(await boundedLiveRead(readAccount.call(this.source, user, dexes, remaining()), remaining()));
      if (proof.state.network !== 'testnet' || address(proof.state.accountAddress) !== user || proof.orders.network !== 'testnet' || address(proof.orders.accountAddress) !== user) fail();
      for (const at of [proof.state.observedAt, proof.orders.observedAt, proof.orders.completedAt]) fresh(at, this.now());
      if (proof.orders.completedAt < proof.orders.observedAt) fail();
      const aggregate = z.object({ user: z.string(), clearinghouseStates: z.array(z.tuple([z.string().max(40), stateSchema])).max(MAX_LIVE_PERP_DEXES) }).parse(proof.state.data);
      if (address(aggregate.user) !== user) fail(); unique(aggregate.clearinghouseStates.map(([dex]) => dex));
      const rawStates = (proof.state.data as { clearinghouseStates: [string, Record<string, unknown>][] }).clearinghouseStates;
      for (const [, state] of rawStates) {
        if (state.user !== undefined && (typeof state.user !== 'string' || address(state.user) !== user) || state.network !== undefined && state.network !== 'testnet') fail();
      }
      if (aggregate.clearinghouseStates.length !== dexes.length || aggregate.clearinghouseStates.some(([dex]) => !dexes.includes(dex))) fail();
      for (const [, state] of aggregate.clearinghouseStates) fresh(state.time, this.now());
      const orders = z.object({ requestedDexes: z.array(z.string()).max(MAX_LIVE_PERP_DEXES), venues: z.array(z.object({
        dex: z.string(), user: z.string(), observedAt: integer, receivedAt: integer, orders: z.array(z.unknown()).max(0),
      })).max(MAX_LIVE_PERP_DEXES) }).parse(proof.orders);
      unique(orders.requestedDexes); unique(orders.venues.map(v => v.dex));
      if (orders.requestedDexes.length !== dexes.length || orders.venues.length !== dexes.length ||
          orders.requestedDexes.some(dex => !dexes.includes(dex)) || orders.venues.some(v => !dexes.includes(v.dex))) fail();
      for (const venue of orders.venues) {
        if (address(venue.user) !== user || venue.receivedAt < venue.observedAt || venue.observedAt < proof.orders.observedAt || venue.receivedAt > proof.orders.completedAt) fail();
        fresh(venue.observedAt, this.now()); fresh(venue.receivedAt, this.now());
      }
      const finalDexes = dexSchema.parse(await read('perpDexs', 20));
      if (JSON.stringify(finalDexes) !== JSON.stringify(list)) fail();
      const observedAt = Math.min(started, proof.state.observedAt, proof.orders.observedAt, ...aggregate.clearinghouseStates.map(([, s]) => s.time)), completedAt = this.now();
      fresh(observedAt, completedAt);
      return Object.freeze({ network: 'testnet' as const, accountAddress: user, observedAt, completedAt, dexes: Object.freeze(dexes),
        sourceDigest: accountModeDigest({ user, list, spot, agents, proof, started, completedAt }), complete: true as const, empty: true as const });
    } catch { return fail(); }
  }
}
