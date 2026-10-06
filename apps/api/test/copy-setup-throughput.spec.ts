import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { liveCopySetupIntentSchema, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import { AppConfig } from '../src/config/app-config.js';
import { CopyAccountModeService } from '../src/copy/copy-account-mode.service.js';
import { accountModeDigest, type AccountModeRow } from '../src/copy/copy-account-mode.repository.js';
import { HyperliquidAccountModeAbsenceReader } from '../src/copy/copy-account-mode-evidence.js';
import { CopyLiveSetupService } from '../src/copy/copy-live-setup.service.js';
import type { SetupRow } from '../src/copy/copy-live-setup.repository.js';
import type { LiveAllDexsAccountEvidence, LiveAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { PrivyAccountModeClient } from '../src/copy/live/privy-account-mode-client.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { reserveLive } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';

/**
 * The one-click setup's account-mode and agent steps against the REAL token
 * buckets (RequestBudgeterService, 300/min + 900 burst, as the api's and the
 * worker's testnet buckets are), one shared per-IP meter (1,200 REST and
 * 2,000 WS units a minute, as Postgres keeps them), the dialog's polling
 * (every 2 s, /advance at most every 3 s), the worker's setup pass (every
 * 3 s, its own bucket) and the follower snapshot collector (one all-venue
 * read a minute). Testnet lists 268 perp dexes. Provider I/O, SQL and Privy
 * are in-memory with realistic latencies; time is simulated.
 *
 * Before the fix (2026-10-05 Stage stall): every evidence clock ran through
 * the budget queue, one attempt asked ~1,123 weight of a 900 burst refilling
 * 5/s, the dialog and the worker kept it drained, and the setup never left
 * `funded` (each observation ended `account_mode_evidence_stale`).
 */
const T0 = 1_800_000_000_000;
const DEXES = 268, REST_CAP = 1200, WS_CAP = 2000, WINDOW = 65_000;
const master = privateKeyToAccount(`0x${'0a'.repeat(32)}`), owner = privateKeyToAccount(`0x${'0b'.repeat(32)}`);
const accountAddress = master.address.toLowerCase(), ownerAddress = owner.address.toLowerCase(), agentAddress = `0x${'33'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The shared per-IP meter (postgres-hyperliquid-quota), in memory. */
class Meter {
  events: { kind: 'rest' | 'ws'; units: number; expiresAt: number }[] = [];
  peak = { rest: 0, ws: 0 }; refusals: string[] = []; charged = { rest: 0, ws: 0 };
  private used(kind: 'rest' | 'ws') { const now = Date.now(); this.events = this.events.filter(e => e.expiresAt > now); return this.events.filter(e => e.kind === kind).reduce((s, e) => s + e.units, 0); }
  charge(kind: 'rest' | 'ws', units: number, who: string) {
    const used = this.used(kind), cap = kind === 'rest' ? REST_CAP : WS_CAP;
    if (used + units > cap) {
      this.refusals.push(`${who} ${kind} ${units} at ${used}`);
      if (kind === 'rest') { const first = [...this.events].filter(e => e.kind === 'rest').sort((a, b) => a.expiresAt - b.expiresAt)[0]; throw new HyperliquidRestCapacityError(Math.max(1, Math.min(65_000, (first?.expiresAt ?? Date.now() + 1) - Date.now()))); }
      throw new LiveBoundaryError('hyperliquid_quota_exhausted');
    }
    this.events.push({ kind, units, expiresAt: Date.now() + WINDOW }); this.charged[kind] += units;
    this.peak[kind] = Math.max(this.peak[kind], used + units);
  }
}

/** Testnet as the provider answers it: the mode flips once the POST lands. */
class Testnet {
  disabled = false; posts = 0;
  readonly dexes = [null, ...Array.from({ length: DEXES - 1 }, (_, i) => ({ name: `dex${i}` }))];
  fetch: typeof fetch = async (input, init) => {
    await sleep(120);
    const url = String(input), body = JSON.parse(String(init?.body));
    if (url.endsWith('/exchange')) { this.posts++; this.disabled = true; return Response.json({ status: 'ok', response: { type: 'default' } }); }
    const answers: Record<string, unknown> = { userRole: { role: 'user' }, userAbstraction: this.disabled ? 'disabled' : 'default', userDexAbstraction: this.disabled ? false : null,
      spotClearinghouseState: { balances: [], portfolioMarginEnabled: false }, perpDexs: this.dexes, extraAgents: [], clearinghouseState: { withdrawable: '100' } };
    if (!(body.type in answers)) throw new Error(`unexpected ${body.type}`);
    return Response.json(answers[body.type]);
  };
}

/** One process's Hyperliquid stack on the shared meter. */
function processStack(meter: Meter, testnet: Testnet, name: string) {
  const budget = new RequestBudgeterService(new AppConfig({ hyperliquid: { budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, pageReserveShare: 0.25 } } as never));
  const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
  const acquireRest = async (weight: number, deadline: number) => {
    await sleep(15); meter.charge('rest', weight, name);
    let used = false;
    const assertFresh = () => { if (Date.now() >= deadline) throw new LiveBoundaryError('hyperliquid_quota_expired'); };
    return { assertFresh, dispatch: <T>(work: () => T): T => { assertFresh(); if (used) throw new Error('reused'); used = true; return work(); } };
  };
  vi.spyOn(quota, 'bindUnscoped').mockReturnValue({ acquireRest, reserveSocket: vi.fn() });
  const transport = new HyperliquidGlobalTransport(quota, { egressKey: `sim-${name}:testnet`, ownerId: name }, testnet.fetch, Date.now, ms => sleep(ms));
  return { budget, transport };
}

/** The all-venue WS source (live-account-ws-source): one read at a time,
 * at most one a second; 2 units per subscription with its unsubscribe
 * prepaid (the collector), or 1 per subscription and one close
 * (`closeAfterRead`, the account-mode absence proof). */
function allVenueSource(meter: Meter, name: string, closeAfterRead: boolean): LiveAllDexsAccountSource {
  let busy = false, last = 0;
  const readAccount = async (user: string, dexes: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<LiveAllDexsAccountEvidence> => {
    if (busy || Date.now() - last < 1000 || timeoutMs < 1) throw new LiveBoundaryError('live_account_aggregate_unavailable');
    if (signal?.aborted) throw new LiveBoundaryError('live_account_read_abandoned');
    busy = true; last = Date.now();
    try {
      meter.charge('ws', closeAfterRead ? dexes.length + 2 : 2 * dexes.length + 2, name);
      const observedAt = Date.now(); await sleep(Math.min(timeoutMs, 900));
      if (Date.now() - observedAt >= timeoutMs) throw new LiveBoundaryError('live_account_orders_deadline_exceeded');
      const state = { marginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' },
        crossMarginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '100', time: observedAt, assetPositions: [] };
      return { state: { network: 'testnet', accountAddress: user, observedAt, data: { user, clearinghouseStates: dexes.map(dex => [dex, state]) } },
        orders: { network: 'testnet', accountAddress: user, observedAt, completedAt: Date.now(), requestedDexes: [...dexes],
          venues: dexes.map(dex => ({ dex, user, observedAt, receivedAt: Date.now(), orders: [] })) } };
    } finally { busy = false; }
  };
  return { read: vi.fn(), readAccount };
}

/** Shared rows (the database both processes see), in memory. */
function database(intent: LiveCopySetupIntent, setupId: string) {
  const now = new Date(T0);
  const mode: AccountModeRow = { id: 'mode-op', userId: 1, accountId: intent.accountId, strategyId: intent.strategyId, network: 'testnet', accountAddress, ownerAddress,
    target: 'disabled', revision: 1, submissionState: 'prepared', targetState: 'unproven', issue: null, observedAt: null, attemptedAt: null, createdAt: now, updatedAt: now,
    intent: null, nonce: null, consentExpiresAt: null, intentDigest: null, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'owner-quorum', claimToken: null,
    signingStartedAt: null, consentDigest: null, observation: null, attemptProof: null, acknowledgmentDigest: null, idempotencyKey: 'mode-key', liveSetupId: setupId } as unknown as AccountModeRow;
  const setup = { id: setupId, userId: 1, strategyId: intent.strategyId, accountId: intent.accountId, kind: 'start', idempotencyKey: 'setup-key', leaderAddress: intent.leaderAddress,
    sourceNetwork: 'mainnet', budgetUsd: '100', settings, stage: 'funded', issue: null, signerKind: 'owner_session', intent, intentDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
    consentDigest: 'c'.repeat(64), consentExpiresAt: new Date(intent.consentExpiresAt), confirmedAt: now, setupDeadline: new Date(intent.setupDeadline), fundingOperationId: null,
    modeOperationId: 'mode-op', agentSetupId: 'agent-op', builderApprovalId: null, mandateId: null, attempts: 0, nextAttemptAt: null, leaseUntil: null, revision: 1, createdAt: now, updatedAt: now } as unknown as SetupRow;
  const rows = { mode, setup, agentActive: false, stages: [] as { stage: string; at: number }[], agentIntent: null as null | { id: string; strategyId: number; network: 'testnet'; accountAddress: string; agentAddress: string;
    policyId: string; workerQuorumId: string; expiresAt: number; nonce: number; consentExpiresAt: number } };
  const io = async <T>(value: T): Promise<T> => { await sleep(4); return structuredClone(value); };
  const modeRepository = {
    find: async () => io(rows.mode), assertCurrent: async () => io({ owner: { privyUserId: 'did:privy:owner' }, account: { externalId: 'ext', masterPolicyId: null, masterSignerQuorumId: null } }),
    transition: async (row: AccountModeRow, changes: Partial<AccountModeRow>) => {
      await sleep(4); if (row.revision !== rows.mode.revision || row.submissionState !== rows.mode.submissionState) return null;
      rows.mode = { ...rows.mode, ...changes, revision: rows.mode.revision + 1, updatedAt: new Date() }; return structuredClone(rows.mode);
    },
    challenge: async (_tx: unknown, _user: number, row: AccountModeRow, assertFresh: () => void, minRemainingMs = 0) => {
      await sleep(8); assertFresh();
      if (rows.mode.revision !== row.revision || rows.mode.submissionState !== 'prepared') throw new Error('account_mode_challenge_changed');
      if (rows.mode.intent && rows.mode.consentExpiresAt && rows.mode.consentExpiresAt.getTime() > Date.now() + minRemainingMs) return structuredClone(rows.mode);
      const nonce = Date.now(), modeIntent = { operationId: rows.mode.id, accountId: rows.mode.accountId, strategyId: rows.mode.strategyId, network: 'testnet' as const, accountAddress, nonce, consentExpiresAt: nonce + 300_000 };
      rows.mode = { ...rows.mode, nonce, consentExpiresAt: new Date(nonce + 300_000), intent: modeIntent, intentDigest: accountModeDigest(modeIntent), revision: rows.mode.revision + 1 } as AccountModeRow;
      assertFresh(); return structuredClone(rows.mode);
    },
  };
  const setupRepository = {
    find: async () => io(rows.setup), get: async () => io(rows.setup), owner: async () => io({ id: 1 }),
    open: async (at: Date) => io([rows.setup].filter(r => ['funded', 'mode_set', 'agent_active', 'builder_ready'].includes(r.stage) && (!r.nextAttemptAt || r.nextAttemptAt <= at))),
    lease: async (_id: string, ms: number) => { await sleep(4); if (rows.setup.leaseUntil && rows.setup.leaseUntil.getTime() > Date.now()) return null; rows.setup = { ...rows.setup, leaseUntil: new Date(Date.now() + ms) }; return structuredClone(rows.setup); },
    release: async () => { await sleep(4); rows.setup = { ...rows.setup, leaseUntil: null }; },
    transition: async (row: SetupRow, changes: Partial<SetupRow>) => {
      await sleep(4); if (row.revision !== rows.setup.revision) return null;
      if (changes.stage && changes.stage !== rows.setup.stage) rows.stages.push({ stage: changes.stage, at: Date.now() - T0 });
      rows.setup = { ...rows.setup, ...changes, revision: rows.setup.revision + 1, updatedAt: new Date() }; return structuredClone(rows.setup);
    },
  };
  return { rows, modeRepository, setupRepository };
}

/** One process: its bucket, clients and services on the shared rows and meter. */
function setupProcess(name: string, meter: Meter, testnet: Testnet, db: ReturnType<typeof database>) {
  const { budget, transport } = processStack(meter, testnet, name);
  // As copy.module wires them: weight is reserved before an evidence clock starts.
  const live = (weight: number, options?: { maxWaitMs?: number; signal?: AbortSignal }) => reserveLive(budget, weight, options);
  const config = new AppConfig({ hyperliquid: { wallet: { network: 'testnet' } }, copy: { mode: 'testnet' } } as never);
  const client = new PrivyAccountModeClient({ appId: 'app', appSecret: 'secret' }, live, testnet.fetch, Date.now, transport);
  const absence = new HyperliquidAccountModeAbsenceReader(live, transport.fetchInfo, Date.now, allVenueSource(meter, name, true), transport);
  const wallets = { available: true, findOwned: async () => { await sleep(150); return { id: 'master-wallet', address: accountAddress, externalId: 'ext', ownerQuorumId: 'owner-quorum' }; } };
  const uow = { run: <T>(work: (tx: unknown) => Promise<T>) => work({}) };
  const modes = new CopyAccountModeService(db.modeRepository as never, uow as never, config, wallets as never, client, absence);
  const agents = {
    available: true,
    row: async () => { await sleep(4); return { state: db.rows.agentActive ? 'active' : 'ready', agentAddress, expiresAt: new Date((db.rows.setup.intent as { agentValidUntil: number }).agentValidUntil), policyId: 'agent-policy' }; },
    reconcile: async () => undefined,
    // The approval's nonce (its own five-minute window), kept while it lasts.
    challengeRow: async () => {
      await sleep(300); // the agent's Privy identity checks
      if (!db.rows.agentIntent || db.rows.agentIntent.consentExpiresAt <= Date.now()) {
        const nonce = Date.now();
        db.rows.agentIntent = { id: 'agent-op', strategyId: 7, network: 'testnet' as const, accountAddress, agentAddress, policyId: 'agent-policy', workerQuorumId: 'worker-quorum',
          expiresAt: (db.rows.setup.intent as { agentValidUntil: number }).agentValidUntil, nonce, consentExpiresAt: nonce + 300_000 };
      }
      return structuredClone(db.rows.agentIntent);
    },
    submit: async (_user: number, _id: string, authority: { sign: (m: unknown, i: unknown, f: () => void) => Promise<string> }) => {
      await sleep(300); // the agent's Privy identity checks
      await authority.sign({ walletId: 'master-wallet', address: accountAddress, ownerQuorumId: 'owner-quorum' }, db.rows.agentIntent, () => undefined);
      // The POST (1) and the observation after it (userRole 60 + extraAgents 20).
      await live(81); meter.charge('rest', 1, name); await sleep(150); meter.charge('rest', 80, name); await sleep(150);
      db.rows.agentActive = true; return { state: 'active' };
    },
  };
  const mandates = { prepareFromSetup: async () => { await sleep(20); return { id: 'mandate-1' }; } };
  const serviceConfig = new AppConfig({ hyperliquid: { wallet: { network: 'testnet' } }, copy: { mode: 'testnet' } } as never);
  const service = new CopyLiveSetupService(serviceConfig, db.setupRepository as never, uow as never, mandates as never, {} as never, {} as never, agents as never, modes,
    {} as never, {} as never, {} as never, {} as never, null, Date.now);
  return { service, budget, absence };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one-click setup throughput on the real testnet buckets', () => {
  it('reaches mode_set, agent_active and running under the dialog, the worker and the collector, never over the shared meter', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // Every timeout on the simulated clock (AbortSignal.timeout runs on its own timer).
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; });
    const setupId = randomUUID(), nonce = T0 - 120_000;
    const intent = liveCopySetupIntentSchema.parse({ kind: 'start', setupId, userId: 1, ownerAddress, ownerPrivyUserId: 'did:privy:owner', strategyId: 7, leaderAddress: `0x${'44'.repeat(20)}`,
      sourceNetwork: 'mainnet', network: 'testnet', budgetUsd: '100', settingsDigest: 'd'.repeat(64), accountId: 'account-7', accountAddress, accountAbstraction: 'disabled',
      agentAddress, agentPolicyId: 'agent-policy', agentPolicyFingerprint: 'a'.repeat(64), workerQuorumId: 'worker-quorum', agentValidUntil: T0 + 30 * 86_400_000 - 120_000,
      builderAddress: null, builderMaxFeeTenthsOfBps: 0, sweepDestination: ownerAddress, masterPolicyId: '', masterPolicyFingerprint: '', fundingOperationId: randomUUID(), fundingNonce: nonce - 1,
      fundingAmount: '100', nonce, consentExpiresAt: nonce + 300_000, setupDeadline: nonce + 24 * 3_600_000 });
    const meter = new Meter(), testnet = new Testnet(), db = database(intent, setupId);
    const api = setupProcess('api', meter, testnet, db), worker = setupProcess('worker', meter, testnet, db);
    const collector = allVenueSource(meter, 'collector', false);
    // As on Stage after an hour of failed attempts: the api's bucket is empty
    // and the shared window holds the last minute's charges.
    await api.budget.acquire(900, 'live'); meter.charge('rest', 600, 'earlier'); meter.charge('ws', 538, 'earlier');

    let advancing = false, ticking = false, advanceAt = 0, advances = 0;
    const signed: string[] = [];
    const errors: string[] = [];
    const deadline = T0 + 10 * 60_000;
    let nextPoll = T0, nextTick = T0 + 1_000, nextCollect = T0 + 5_000;
    while (Date.now() < deadline && db.rows.setup.stage !== 'running') {
      const now = Date.now();
      // The dialog: a poll every 2 s; /advance at most every 3 s, one at a time.
      if (now >= nextPoll) {
        nextPoll = now + 2_000;
        if (!advancing && now >= advanceAt) {
          advancing = true; advanceAt = now + 3_000; advances++;
          // A pending action is signed in the browser (Privy's iframe: about 1 s) and sent back.
          void api.service.advance(1, setupId).then(async read => {
            const pending = read.pendingSignature;
            if (!pending) return;
            await sleep(1_000); signed.push(pending.kind);
            await api.service.advance(1, setupId, { digest: pending.digest, signature: await master.signTypedData(pending.typedData as never) });
          }).catch(error => { errors.push(String(error?.message ?? error)); }).finally(() => { advancing = false; });
        }
      }
      // The worker's setup pass (the live engine's tick).
      if (now >= nextTick && !ticking) {
        nextTick = now + 3_000; ticking = true;
        void worker.service.tick().catch(error => { errors.push(String(error?.message ?? error)); }).finally(() => { ticking = false; });
      }
      // The follower snapshot collector: one all-venue read a minute.
      if (now >= nextCollect) {
        nextCollect = now + 60_000;
        void collector.readAccount!(`0x${'55'.repeat(20)}`, ['', ...testnet.dexes.slice(1).map(d => d!.name)], 5_000).catch(error => { errors.push(`collector ${String(error?.message ?? error)}`); });
      }
      await vi.advanceTimersByTimeAsync(100);
    }
    const elapsed = Date.now() - T0;
    if (process.env.SETUP_SIM_OUT) (await import('node:fs')).writeFileSync(process.env.SETUP_SIM_OUT, JSON.stringify({ elapsedMs: elapsed, stages: db.rows.stages, issue: db.rows.setup.issue, posts: testnet.posts, advances, meter: { peak: meter.peak, charged: meter.charged, refusals: meter.refusals.slice(0, 5) }, errors: errors.slice(0, 5) }));
    expect(db.rows.stages.map(s => s.stage)).toEqual(['mode_set', 'agent_active', 'builder_ready', 'running']);
    expect(elapsed).toBeLessThan(3 * 60_000);
    expect(testnet.posts).toBe(1); // exactly one userSetAbstraction POST (the agent's is simulated)
    // The mode change and the agent approval, each signed once in the browser
    // (a budget wait reuses the signature while its nonce lasts).
    expect(signed).toEqual(['account_mode', 'agent_approval']);
    expect(errors).toEqual([]);
    expect(meter.peak.rest).toBeLessThanOrEqual(REST_CAP); expect(meter.peak.ws).toBeLessThanOrEqual(WS_CAP);
    expect(meter.refusals).toEqual([]);
  }, 60_000);
});
