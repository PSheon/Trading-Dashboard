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
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { planHyperliquidQuota, type HyperliquidQuotaRequest, type HyperliquidQuotaState } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { reserveLive } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';

/**
 * The pre-mainnet gate of 2026-10-13 (`copy_setup_running FAIL funded
 * (hyperliquid_busy) after 602 s`), simulated: the one-click setup's
 * funded → mode_set → agent_active → running steps on the REAL shared-meter
 * planner (hyperliquid-global-quota.ts, through PostgresHyperliquidQuota's
 * own lane and ticket logic; only its SQL transaction is in memory), with
 * the background lane kept full as contention.mjs keeps it (eight loops
 * asking 20 each, retrying a refusal after 250–500 ms) and a live copy's
 * orders beside it. Time is simulated.
 *
 * Before the fix: the setup's reads were unlabelled, so they had only the
 * 360 background's 840 left (an attempt needs ~500 in its minute), the
 * background loops took every unit that expired below 840, and each refusal
 * waited a fixed 65 s: the setup never left `funded`.
 */
const T0 = 1_800_000_000_000;
const DEXES = 268;
const master = privateKeyToAccount(`0x${'0a'.repeat(32)}`), owner = privateKeyToAccount(`0x${'0b'.repeat(32)}`);
const accountAddress = master.address.toLowerCase(), ownerAddress = owner.address.toLowerCase(), agentAddress = `0x${'33'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The meter's one row, planned by the real planner (the DAL's SQL in memory). */
class Meter {
  state: HyperliquidQuotaState = { egressKey: 'gate:testnet', revision: 1, events: [], updatedAt: T0 };
  peak = 0;
  restHeld() { const now = Date.now(); return this.state.events.filter(e => e.kind === 'rest' && e.expiresAt > now).reduce((s, e) => s + e.units, 0); }
  /** PostgresHyperliquidQuota whose transaction runs here, as one row lock would. */
  quota(): PostgresHyperliquidQuota {
    // Its clocks on the simulated time (the background-full cache is monotonic).
    const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb), () => Date.now(), () => Date.now());
    type Apply = (binding: unknown, request: (now: number, sendUntil: number) => HyperliquidQuotaRequest, deadline: number | undefined, session?: unknown, evidence?: unknown, seen?: (plan: ReturnType<typeof planHyperliquidQuota>) => void) => Promise<() => void>;
    const apply: Apply = async (_binding, request, deadline, _session, _evidence, seen) => {
      await sleep(10); // the meter's transaction at a Stage-like round trip
      const now = Date.now(), plan = planHyperliquidQuota({ now, state: this.state, leases: [], request: request(now, deadline ?? now + 5000) });
      this.state = structuredClone(plan.state) as HyperliquidQuotaState; seen?.(plan);
      this.peak = Math.max(this.peak, this.restHeld());
      return () => { if (deadline !== undefined && Date.now() > deadline) throw new LiveBoundaryError('hyperliquid_quota_expired'); };
    };
    (quota as unknown as { apply: Apply }).apply = apply;
    return quota;
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

/** The all-venue WS source (its socket units are another meter; not modelled). */
function allVenueSource(): LiveAllDexsAccountSource {
  const readAccount = async (user: string, dexes: readonly string[], timeoutMs: number): Promise<LiveAllDexsAccountEvidence> => {
    const observedAt = Date.now(); await sleep(Math.min(timeoutMs, 900));
    const state = { marginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '100', totalRawUsd: '100', totalNtlPos: '0', totalMarginUsed: '0' }, crossMaintenanceMarginUsed: '0', withdrawable: '100', time: observedAt, assetPositions: [] };
    return { state: { network: 'testnet', accountAddress: user, observedAt, data: { user, clearinghouseStates: dexes.map(dex => [dex, state]) } },
      orders: { network: 'testnet', accountAddress: user, observedAt, completedAt: Date.now(), requestedDexes: [...dexes],
        venues: dexes.map(dex => ({ dex, user, observedAt, receivedAt: Date.now(), orders: [] })) } };
  };
  return { read: vi.fn(), readAccount };
}

const io = async <T>(value: T): Promise<T> => { await sleep(4); return structuredClone(value); };
function database(intent: LiveCopySetupIntent, setupId: string) {
  const now = new Date(T0);
  const mode: AccountModeRow = { id: 'mode-op', userId: 1, accountId: intent.accountId, strategyId: intent.strategyId, network: 'testnet', accountAddress, ownerAddress,
    target: 'disabled', revision: 1, submissionState: 'prepared', targetState: 'unproven', issue: null, observedAt: null, attemptedAt: null, createdAt: now, updatedAt: now,
    intent: null, nonce: null, consentExpiresAt: null, intentDigest: null, accountWalletId: 'master-wallet', accountOwnerQuorumId: 'owner-quorum', claimToken: null,
    signingStartedAt: null, consentDigest: null, observation: null, attemptProof: null, acknowledgmentDigest: null, idempotencyKey: 'mode-key', liveSetupId: setupId } as unknown as AccountModeRow;
  const setup = { id: setupId, userId: 1, strategyId: intent.strategyId, accountId: intent.accountId, kind: 'start', idempotencyKey: 'setup-key', leaderAddress: intent.leaderAddress,
    sourceNetwork: 'mainnet', budgetUsd: '100', settings, stage: 'funded', issue: null, intent, intentDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
    consentDigest: 'c'.repeat(64), consentExpiresAt: new Date(intent.consentExpiresAt), confirmedAt: now, setupDeadline: new Date(intent.setupDeadline), fundingOperationId: null,
    modeOperationId: 'mode-op', agentSetupId: 'agent-op', builderApprovalId: null, mandateId: null, attempts: 0, nextAttemptAt: null, leaseUntil: null, revision: 1, createdAt: now, updatedAt: now } as unknown as SetupRow;
  const rows = { mode, setup, agentActive: false, stages: [] as { stage: string; at: number }[], waits: [] as unknown[], agentIntent: null as null | { id: string; strategyId: number; network: 'testnet'; accountAddress: string; agentAddress: string;
    policyId: string; workerQuorumId: string; expiresAt: number; nonce: number; consentExpiresAt: number } };
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
    aborted: async () => io(false),
    find: async () => io(rows.setup), get: async () => io(rows.setup), owner: async () => io({ id: 1 }),
    open: async (at: Date) => io([rows.setup].filter(r => ['funded', 'mode_set', 'agent_active', 'builder_ready'].includes(r.stage) && (!r.nextAttemptAt || r.nextAttemptAt <= at))),
    lease: async (_id: string, ms: number) => { await sleep(4); if (rows.setup.leaseUntil && rows.setup.leaseUntil.getTime() > Date.now()) return null; rows.setup = { ...rows.setup, leaseUntil: new Date(Date.now() + ms) }; return structuredClone(rows.setup); },
    release: async () => { await sleep(4); rows.setup = { ...rows.setup, leaseUntil: null }; },
    abandonedApprovals: async () => io([]),
    transition: async (row: SetupRow, changes: Partial<SetupRow>) => {
      await sleep(4); if (row.revision !== rows.setup.revision) return null;
      if (changes.stage && changes.stage !== rows.setup.stage) rows.stages.push({ stage: changes.stage, at: Date.now() - T0 });
      if (changes.lastWait) rows.waits.push(changes.lastWait);
      rows.setup = { ...rows.setup, ...changes, revision: rows.setup.revision + 1, updatedAt: new Date() }; return structuredClone(rows.setup);
    },
  };
  return { rows, modeRepository, setupRepository };
}

/** The worker: its bucket, transport, clients and setup service on the shared rows and meter. */
function worker(meter: Meter, testnet: Testnet, db: ReturnType<typeof database>, signed: string[]) {
  const budget = new RequestBudgeterService(new AppConfig({ hyperliquid: { budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, pageReserveShare: 0.25 } } as never));
  const quota = meter.quota();
  const transport = new HyperliquidGlobalTransport(quota, { egressKey: 'gate:testnet', ownerId: 'worker' }, testnet.fetch, Date.now, ms => sleep(ms));
  const live = (weight: number, options?: { maxWaitMs?: number; signal?: AbortSignal }) => reserveLive(budget, weight, options);
  const config = new AppConfig({ hyperliquid: { wallet: { network: 'testnet' } }, copy: { mode: 'testnet' } } as never);
  const client = new PrivyAccountModeClient({ appId: 'app', appSecret: 'secret' }, live, testnet.fetch, Date.now, transport);
  const absence = new HyperliquidAccountModeAbsenceReader('testnet', live, transport.fetchInfo, Date.now, allVenueSource(), transport);
  const wallets = { available: true, findOwned: async () => { await sleep(150); return { id: 'master-wallet', address: accountAddress, externalId: 'ext', ownerQuorumId: 'owner-quorum' }; } };
  const uow = { run: <T>(work: (tx: unknown) => Promise<T>) => work({}) };
  const modes = new CopyAccountModeService(db.modeRepository as never, uow as never, config, wallets as never, client, absence);
  const agents = {
    available: true,
    row: async () => { await sleep(4); return { state: db.rows.agentActive ? 'active' : 'ready', agentAddress, expiresAt: new Date((db.rows.setup.intent as { agentValidUntil: number }).agentValidUntil), policyId: 'agent-policy' }; },
    reconcile: async () => undefined,
    challengeRow: async () => {
      await sleep(300);
      if (!db.rows.agentIntent || db.rows.agentIntent.consentExpiresAt <= Date.now()) {
        const nonce = Date.now();
        db.rows.agentIntent = { id: 'agent-op', strategyId: 7, network: 'testnet' as const, accountAddress, agentAddress, policyId: 'agent-policy', workerQuorumId: 'worker-quorum',
          expiresAt: (db.rows.setup.intent as { agentValidUntil: number }).agentValidUntil, nonce, consentExpiresAt: nonce + 300_000 };
      }
      return structuredClone(db.rows.agentIntent);
    },
    // The approval's POST (1) and the observation after it (userRole 60 +
    // extraAgents 20), each a charge of the shared meter as the real clients make.
    submit: async (_user: number, _id: string, authority: { sign: (m: unknown, i: unknown, f: () => void) => Promise<string> }) => {
      await sleep(300);
      await authority.sign({ walletId: 'master-wallet', address: accountAddress, ownerQuorumId: 'owner-quorum' }, db.rows.agentIntent, () => undefined);
      await live(81);
      const post = await transport.currentQuota().acquireRest(1, Date.now() + 5000); post.dispatch(() => undefined); await sleep(150);
      await transport.fetchInfoBatch('https://api.hyperliquid-testnet.xyz/info', [{ type: 'userRole', user: accountAddress }, { type: 'extraAgents', user: accountAddress }], { maxWaitMs: 8_000 });
      db.rows.agentActive = true; return { state: 'active' };
    },
  };
  const mandates = { prepareFromSetup: async () => { await sleep(20); return { id: 'mandate-1' }; } };
  const walletRows = { account: async () => io({ masterPolicyId: 'master-policy', masterSignerQuorumId: 'worker-quorum', signerDetachedAt: null }) };
  const workerSigner = { available: true, sign: async (_account: unknown, data: { primaryType: string }) => { await sleep(1_000); signed.push(data.primaryType); return master.signTypedData(data as never); } };
  // As copy.module wires it: the wallet network's transport is the setups' lane on the meter.
  const service = new CopyLiveSetupService(config, db.setupRepository as never, uow as never, mandates as never, {} as never, walletRows as never, agents as never, modes,
    {} as never, {} as never, {} as never, {} as never, workerSigner, Date.now, null, null, null, transport);
  return { service, quota };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a copy setup beside a full background lane (2026-10-13 gate)', () => {
  it('gets funded → mode_set → agent_active → running within a bounded time; live orders keep going; background is refused first', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; });
    const setupId = randomUUID(), nonce = T0 - 120_000;
    const intent = liveCopySetupIntentSchema.parse({ kind: 'start', setupId, userId: 1, ownerAddress, ownerPrivyUserId: 'did:privy:owner', strategyId: 7, leaderAddress: `0x${'44'.repeat(20)}`,
      sourceNetwork: 'mainnet', network: 'testnet', budgetUsd: '100', settingsDigest: 'd'.repeat(64), accountId: 'account-7', accountAddress, accountAbstraction: 'disabled',
      agentAddress, agentPolicyId: 'agent-policy', agentPolicyFingerprint: 'a'.repeat(64), workerQuorumId: 'worker-quorum', agentValidUntil: T0 + 30 * 86_400_000 - 120_000,
      builderAddress: null, builderMaxFeeTenthsOfBps: 0, sweepDestination: ownerAddress, masterPolicyId: '', masterPolicyFingerprint: '', fundingOperationId: randomUUID(), fundingNonce: nonce - 1,
      fundingAmount: '100', nonce, consentExpiresAt: nonce + 300_000, setupDeadline: nonce + 24 * 3_600_000 });
    const meter = new Meter(), testnet = new Testnet(), db = database(intent, setupId), signed: string[] = [];
    const { service, quota } = worker(meter, testnet, db, signed);

    // contention.mjs: eight loops keep the background lane full.
    let stop = false;
    const background = { granted: 0, refused: 0, errors: 0, grantedWhileSetup: 0, refusedWhileSetup: 0 };
    let setupRunning = false, jitter = 0;
    const loops = Array.from({ length: 8 }, async (_, n) => {
      const lane = meter.quota().bindUnscoped({ egressKey: 'gate:testnet', ownerId: `harness-background-${n}` });
      while (!stop) {
        try { await lane.acquireRest(20, Date.now() + 5000, 'background'); background.granted++; if (setupRunning) background.grantedWhileSetup++; await sleep(50); }
        catch (error) {
          const retry = sharedRestRetryAfterMs(error);
          if (retry === undefined) background.errors++; else { background.refused++; if (setupRunning) background.refusedWhileSetup++; }
          jitter = (jitter + 97) % 250; await sleep(Math.min(retry ?? 1000, 250 + jitter));
        }
      }
    });
    // A live copy's orders: an order's unlabelled charges (its boundary
    // read, account snapshot and the POST) every 10 s.
    const liveOrders = { sent: 0, refused: 0 };
    const orders = (async () => {
      const bound = quota.bindUnscoped({ egressKey: 'gate:testnet', ownerId: 'live' });
      while (!stop) {
        await sleep(10_000);
        for (const weight of [21, 22, 1]) {
          try { (await bound.acquireRest(weight, Date.now() + 5000)).dispatch(() => undefined); liveOrders.sent++; } catch { liveOrders.refused++; }
        }
      }
    })();
    // A minute of background first: its 840 spread over the window, as on Stage.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(meter.restHeld()).toBeGreaterThanOrEqual(820);
    expect(background.refused).toBeGreaterThan(0);

    const started = Date.now();
    setupRunning = true;
    let ticking = false, nextTick = started;
    const errors: string[] = [];
    const deadline = started + 10 * 60_000;
    while (Date.now() < deadline && db.rows.setup.stage !== 'running') {
      if (Date.now() >= nextTick && !ticking) {
        nextTick = Date.now() + 3_000; ticking = true;
        void service.tick().catch(error => { errors.push(String(error?.message ?? error)); }).finally(() => { ticking = false; });
      }
      await vi.advanceTimersByTimeAsync(100);
    }
    setupRunning = false;
    const elapsed = Date.now() - started;
    // Background has its cap again once no setup waits.
    const grantedBefore = background.granted;
    await vi.advanceTimersByTimeAsync(130_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([...loops, orders]);

    expect(db.rows.stages.map(s => s.stage)).toEqual(['mode_set', 'agent_active', 'builder_ready', 'running']);
    // Bounded: the background ahead of it drains within a charge's 65 s,
    // once; never a 65 s window per try (before: never, after 600 s).
    expect(elapsed).toBeLessThan(180_000);
    expect(testnet.posts).toBe(1);
    expect(signed).toEqual(['HyperliquidTransaction:UserSetAbstraction', 'HyperliquidTransaction:ApproveAgent']);
    expect(errors).toEqual([]);
    // Every wait the setup had was the meter's own estimate, never a blind 65 s.
    for (const wait of db.rows.waits as { reason: string; retryMs: number }[]) if (wait.reason === 'shared_capacity') expect(wait.retryMs).toBeLessThan(65_000);
    // Live orders all went out while the setup ran beside a full background lane.
    expect(liveOrders.refused).toBe(0);
    expect(liveOrders.sent).toBeGreaterThan(30);
    // Background was refused first, and has its share again afterwards.
    expect(background.errors).toBe(0);
    expect(background.refusedWhileSetup).toBeGreaterThan(100);
    expect(background.grantedWhileSetup).toBeLessThan(background.refusedWhileSetup / 50);
    expect(background.granted - grantedBefore).toBeGreaterThan(20);
    // Never over the provider's per-IP 1200.
    expect(meter.peak).toBeLessThanOrEqual(1200);
  }, 120_000);
});
