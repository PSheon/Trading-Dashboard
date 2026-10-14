import { Logger } from '@nestjs/common';
import { setTimeout as yieldIo } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { CopySetupDueListener } from '../src/copy/live-worker/copy-setup-due.listener.js';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, copyFundingInputSchema, DEFAULT_COPY_RISK_LIMITS, findHttpContract, leaderCopyActivity, type LeaderCopyActivity, liveCopySetupConsentTypedData, liveCopySetupSchema, liveCopySetupAbortSchema, usdSendTypedData, WALLET_NETWORKS, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import { appSettings, copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyFundingOperations, copyLiveActivations, copyLiveBuilderApprovals, copyLiveMandates, copyLiveSetupAborts, copyLiveSetups,
  copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyWalletAuthorizations, leaders } from '@trading-dashboard/shared/database';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyFundingRepository, type FundingSender } from '../src/copy/copy-funding.repository.js';
import { CopyFundingService, wire as fundingWire } from '../src/copy/copy-funding.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveSetupRepository } from '../src/copy/copy-live-setup.repository.js';
import { CopyLiveSetupService, setupFundingKey } from '../src/copy/copy-live-setup.service.js';
import { CopyLiveSetupAbortRepository } from '../src/copy/copy-live-setup-abort.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveSetupAbortReturnRepository, SETUP_ABORT_RESIDUAL_RETURNS } from '../src/copy/copy-live-setup-abort-return.repository.js';
import { classify } from '../src/copy/live/error-class.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import type { SetupAbortFlatObservation } from '../src/copy/live/live-account-observer.js';
import { CopyLiveSetupAbortService } from '../src/copy/copy-live-setup-abort.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { requestContext } from '../src/runtime/request-middleware.js';
import { CopyLiveSetupController } from '../src/copy/copy-live-setup.controller.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { currentRequestSignal, withRequestSignal } from '../src/runtime/request-context.js';
import { HyperliquidBudgetWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import type { AgentConsentIntent } from '../src/copy/copy-agent-consent.js';
import { AgentIdentityEvidenceExpired } from '../src/copy/copy-agent.service.js';
import type { AppConfig } from '../src/config/app-config.js';
import { AccountRepository } from '../src/users/account.repository.js';
import { testConfig as baseTestConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, openCopyTrading, truncateAll, type TestDb } from './db-test-utils.js';
import { ALERT_EVERY_MS } from '../src/config/constants/alerts.js';
import { SETUP_ABORT_BLOCKED_RECHECK_MS, SETUP_ABORT_NOT_FLAT_ESCALATE_MS } from '../src/config/constants/timings.js';

// The setup service and its SQL are real (Postgres); the providers behind the
// wallet, agent, mode and deposit steps are doubles that keep the same rows
// the real services keep, so the generation step runs the real preparation.
const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), stranger = privateKeyToAccount(`0x${'05'.repeat(32)}`);
// The copy account: a Privy wallet the owner alone owns; the worker signs for it under the owner's policy.
const copyAccount = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const leader = `0x${'44'.repeat(20)}`, accountAddress = copyAccount.address.toLowerCase(), agentAddress = `0x${'33'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
let testNetwork: 'testnet' | 'mainnet' = 'testnet';
function testConfig(): AppConfig {
  const base = baseTestConfig();
  return { get value() { const value = base.value; return { ...value, hyperliquid: { ...value.hyperliquid,
    wallet: { ...value.hyperliquid.wallet, network: testNetwork, infoUrl: WALLET_NETWORKS[testNetwork].infoUrl } } }; } } as AppConfig;
}
const flags = { worker: true, attach: true, ticking: false };
let db: TestDb, uid: number, clock: number, service: CopyLiveSetupService;
let mode: { id: string; targetState: string; submissionState: string; submits: number };
/** The mode and agent nonces the fakes allocated (as their services keep them). */
let modeIntent: { operationId: string; accountId: string; strategyId: number; network: 'testnet' | 'mainnet'; accountAddress: string; nonce: number; consentExpiresAt: number } | null;
let agentIntent: AgentConsentIntent | null;
/** What each fake submission's sign callback returned. */
let signed: string[];
const workerSign = vi.fn(async (..._args: unknown[]) => `0x${'cd'.repeat(65)}`);
/** What the leader-activity read answers for a mainnet start (an Error: the read fails). */
const quietLeader = (): LeaderCopyActivity => leaderCopyActivity({ orders: 40, peakPerMinute: 2, saturated: false }, new Date());
let activity: LeaderCopyActivity | Error;

/** API_SETUP_DRIVE as the service reads it (the api's switch). */
let setupDrive: 'local' | 'worker' = 'local';
function config(): AppConfig {
  const base = testConfig();
  return { get value() { return { ...base.value, app: { ...base.value.app, setupDrive }, copy: { mode: 'testnet', workerIntervalMs: 2000, agent: { workerQuorumId: 'worker-quorum', authorizationPrivateKey: 'k', authorizationPublicKey: 'p' },
    live: { network: testNetwork, caps: { maxStrategiesPerUser: 10 }, builderFee: true, testnetSourceIntervalMs: 60_000, maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300 } } } as never; } } as AppConfig;
}
function build() {
  const jobs = new BackgroundJobs();
  const fundingRows = new CopyFundingRepository(db), walletRows = new CopyWalletRepository(db);
  const wallets = {
    get workerPolicyEnabled() { return flags.worker; },
    prepare: vi.fn(async (userId: number, strategyId: number) => {
      const id = `acct-${strategyId}`, address = strategyId === 1 ? accountAddress : `0x${'66'.repeat(19)}${String(strategyId).padStart(2, '0')}`;
      await db.insert(copyExecutionAccounts).values({ id, userId, strategyId, network: testNetwork, privyUserId: 'did:privy:setup-owner', externalId: `ext-${id}`, state: 'ready',
        address, privyWalletId: `master-wallet${strategyId === 1 ? '' : strategyId}`, ownerQuorumId: 'owner-quorum' }).onConflictDoNothing();
      return { id, state: 'ready', address };
    }),
    reconcile: vi.fn(async (_userId: number, id: string) => { const [row] = await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id)); return { id, state: row!.state, address: row!.address }; }),
    prepareSetupPolicy: vi.fn(async () => flags.worker ? { id: 'master-policy', fingerprint: 'c'.repeat(64) } : null),
    attachSetupSigner: vi.fn(async (_userId: number, accountId: string, policy: { id: string; fingerprint: string }) => {
      if (!flags.attach) return false;
      await walletRows.recordMasterSigner(accountId, { masterPolicyId: policy.id, masterPolicyFingerprint: policy.fingerprint, masterSignerQuorumId: 'worker-quorum',
        sweepDestination: owner.address.toLowerCase(), signerAttachedAt: new Date(), walletId: 'master-wallet', address: accountAddress });
      return true;
    }),
  };
  const agents = {
    available: true,
    prepareForSetup: vi.fn(async (userId: number, accountId: string, key: string, liveSetupId: string, days: number) => {
      const [account] = await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId));
      const id = `agent-${liveSetupId.slice(0, 8)}`;
      await db.insert(copyAgentSetups).values({ id, userId, strategyId: account!.strategyId, accountId, network: testNetwork, idempotencyKey: key, validForDays: days, externalId: `agent-ext-${id}`,
        policyAttemptId: `attempt-${id}`, workerQuorumId: 'worker-quorum', policyId: 'agent-policy', policyFingerprint: 'a'.repeat(64), agentWalletId: `agent-wallet-${id}`, agentOwnerQuorumId: 'owner-quorum',
        agentAddress, accountAddress: account!.address!, accountWalletId: account!.privyWalletId!, accountOwnerQuorumId: 'owner-quorum', state: 'ready', liveSetupId, expiresAt: new Date(Date.now() + days * 86_400_000) }).onConflictDoNothing();
      return (await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id)))[0]!;
    }),
    row: vi.fn(async (_userId: number, id: string) => (await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id)))[0]!),
    reconcile: vi.fn(async () => undefined),
    // As the service does: the current nonce while it lasts, else a new one.
    challengeRow: vi.fn(async (_userId: number, id: string) => {
      const [row] = await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id));
      if (!agentIntent || agentIntent.id !== id || agentIntent.consentExpiresAt <= clock) agentIntent = { id, strategyId: row!.strategyId, network: testNetwork, accountAddress, agentAddress,
        policyId: 'agent-policy', workerQuorumId: 'worker-quorum', nonce: clock, expiresAt: row!.expiresAt.getTime(), consentExpiresAt: clock + 300_000 };
      return agentIntent;
    }),
    submit: vi.fn(async (_userId: number, id: string, authority: { kind: string; consentDigest: string; sign: (master: unknown, intent: AgentConsentIntent, fresh: () => void) => Promise<string> }) => {
      const [row] = await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id));
      const now = Date.now();
      signed.push(await authority.sign({ walletId: 'master-wallet', address: accountAddress, ownerQuorumId: 'owner-quorum' }, agentIntent ?? { id, strategyId: row!.strategyId, network: testNetwork, accountAddress, agentAddress,
        policyId: 'agent-policy', workerQuorumId: 'worker-quorum', nonce: clock, expiresAt: row!.expiresAt.getTime(), consentExpiresAt: clock + 300_000 }, () => undefined));
      // As activate does: the grant, then the setup active.
      await db.update(copyAgentSetups).set({ state: 'revoked' }).where(and(eq(copyAgentSetups.accountId, row!.accountId), eq(copyAgentSetups.state, 'active')));
      const walletId = `wallet-${id}`, grantId = `grant-${id}`;
      await db.update(copyExecutionWallets).set({ retiredAt: new Date() }).where(eq(copyExecutionWallets.accountAddress, accountAddress));
      await db.insert(copyExecutionWallets).values({ id: walletId, userId: row!.userId, strategyId: row!.strategyId, network: testNetwork, accountAddress, privyWalletId: row!.agentWalletId!, privyOwnerId: 'owner-quorum', signerAddress: agentAddress });
      await db.insert(copyWalletAuthorizations).values({ id: grantId, walletId, version: 1, scopes: ['copy:trade', 'copy:reduce'], validFrom: new Date(now - 1000), expiresAt: row!.expiresAt, exchangeApprovedAt: new Date(now - 1000) });
      await db.update(copyAgentSetups).set({ state: 'active', authorizationId: grantId, consentDigest: authority.consentDigest, approvalAttemptedAt: new Date(), approvalNonce: now, consentExpiresAt: new Date(now + 300_000) }).where(eq(copyAgentSetups.id, id));
      return { state: 'active' };
    }),
  };
  const modes = {
    available: true,
    ensureForSetup: vi.fn(async () => mode), row: vi.fn(async () => mode), reconcile: vi.fn(async () => mode),
    // No local bucket here: the step's weight is not reserved ahead.
    reserveForSetup: vi.fn(async () => undefined),
    // As the service does: the current nonce while it keeps the minimum left, else a new one.
    setupNonce: vi.fn(async (_userId: number, _id: string, minRemainingMs: number) => {
      if (!modeIntent || modeIntent.consentExpiresAt <= clock + minRemainingMs) modeIntent = { operationId: 'mode-op', accountId: 'a', strategyId: 1, network: testNetwork, accountAddress, nonce: clock, consentExpiresAt: clock + 300_000 };
      return modeIntent;
    }),
    submit: vi.fn(async (_userId: number, _id: string, authority: { sign: (master: unknown, intent: unknown, fresh: () => void) => Promise<string> }) => {
      mode.submits++;
      if (!modeIntent || modeIntent.consentExpiresAt <= clock + 60_000) modeIntent = { operationId: 'mode-op', accountId: 'a', strategyId: 1, network: testNetwork, accountAddress, nonce: clock, consentExpiresAt: clock + 300_000 };
      signed.push(await authority.sign({ walletId: 'master-wallet', address: accountAddress, ownerQuorumId: 'owner-quorum' }, modeIntent, () => undefined));
      mode.targetState = 'supported'; mode.submissionState = 'accepted';
      return mode;
    }),
  };
  const funding = {
    reserve: vi.fn(async (userId: number, accountId: string, input: { idempotencyKey: string; amount: string }, internal?: { liveSetupId: string }) =>
      fundingWire(await fundingRows.reserve(userId, accountId, testNetwork, input, undefined, internal?.liveSetupId))),
    claim: vi.fn(async (userId: number, id: string, via?: FundingSender) => fundingRows.claim(userId, id, via)),
    submit: vi.fn(async (userId: number, id: string, signature: string, via?: FundingSender) => {
      const row = await fundingRows.find(userId, id);
      const valid = await verifyTypedData({ ...(usdSendTypedData(WALLET_NETWORKS[testNetwork], row.destination, row.amount, row.nonce) as unknown as TypedDataDefinition), address: row.address as `0x${string}`, signature: signature as `0x${string}` });
      if (!valid) throw new Error('Invalid funding signature');
      await fundingRows.beginSubmit(userId, id, via);
      return fundingWire(await fundingRows.finish(userId, id, 'accepted', 'e'.repeat(64)));
    }),
    reconcile: vi.fn(async () => undefined),
  };
  const leaderActivity = { copyActivity: vi.fn(async (_address: string) => { if (activity instanceof Error) throw activity; return activity; }) };
  service = new CopyLiveSetupService(config(), new CopyLiveSetupRepository(db), new UnitOfWork(db), new CopyLiveMandateRepository(db, testConfig()), wallets as never, walletRows,
    agents as never, modes as never, funding as never, fundingRows, {} as never, {} as never, { available: true, sign: workerSign } as never, () => flags.ticking ? ++clock : clock, jobs, null, leaderActivity);
  return { wallets, agents, modes, funding, jobs, leaderActivity };
}
let fakes: ReturnType<typeof build>;
const start = (key = 'setup-start-key-000001', extra: object = {}) => service.start(uid, { idempotencyKey: key, leader, budgetUsd: '100', settings, ...extra });
async function sign(intent: LiveCopySetupIntent, signer = owner) {
  return { consentSignature: await signer.signTypedData(liveCopySetupConsentTypedData(intent) as never),
    fundingSignature: intent.kind === 'start' ? await signer.signTypedData(usdSendTypedData(WALLET_NETWORKS[testNetwork], intent.accountAddress, intent.fundingAmount, intent.fundingNonce)) : undefined };
}
async function credit() {
  await db.update(copyFundingOperations).set({ status: 'credited', transactionHash: `0x${'f'.repeat(64)}`, creditedAmount: '100', fee: '0', evidenceHash: 'd'.repeat(64) }).where(eq(copyFundingOperations.direction, 'to_account'));
}
const later = (ms: number) => { clock += ms; };
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  testNetwork = 'testnet'; setupDrive = 'local';
  await truncateAll(db); vi.clearAllMocks(); flags.worker = true; flags.attach = true; flags.ticking = false; clock = Date.now();
  mode = { id: 'mode-op', targetState: 'unknown', submissionState: 'prepared', submits: 0 }; modeIntent = null; agentIntent = null; signed = []; activity = quietLeader();
  uid = (await insertUser(db, { privyUserId: 'did:privy:setup-owner', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await openCopyTrading(db);
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }]);
  await db.insert(appSettings).values({ key: 'revenue', value: adminSettingsSchema.shape.revenue.parse({}) });
  await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS }, reason: 'seeded defaults', createdByUserId: uid });
  fakes = build();
});
afterEach(async () => { vi.useRealTimers(); await fakes?.jobs.drain(1000); });
afterAll(closeTestDb);

describe('leader activity gate', () => {
  it('refuses a mainnet leader too active to copy (409 leader_too_active) and creates nothing', async () => {
    activity = leaderCopyActivity({ orders: 2000, peakPerMinute: 150, saturated: true }, new Date());
    await expect(start()).rejects.toMatchObject({ status: 409, response: { code: 'leader_too_active' } });
    activity = leaderCopyActivity({ orders: 120, peakPerMinute: 9, saturated: false }, new Date());
    await expect(start()).rejects.toMatchObject({ status: 409, response: { code: 'leader_too_active', message: expect.stringContaining('9 a minute') } });
    expect(fakes.leaderActivity.copyActivity).toHaveBeenCalledWith(leader);
    expect(await db.select().from(copyLiveSetups)).toHaveLength(0);
    expect(await db.select().from(copyStrategies)).toHaveLength(0);
    expect(fakes.wallets.prepare).not.toHaveBeenCalled();
  });

  it('fails closed when the activity cannot be read (503 leader_activity_unavailable)', async () => {
    activity = new Error('upstream 500');
    await expect(start()).rejects.toMatchObject({ status: 503, response: { code: 'leader_activity_unavailable' } });
    expect(await db.select().from(copyLiveSetups)).toHaveLength(0);
  });

  it('a quiet leader proceeds; a retry of an admitted key and a testnet leader are not measured', async () => {
    const first = await start();
    expect(first.stage).toBe('awaiting_consent');
    expect(fakes.leaderActivity.copyActivity).toHaveBeenCalledTimes(1);
    activity = new Error('not read again');
    expect((await start()).id).toBe(first.id);
    await start('setup-start-key-000002', { sourceNetwork: 'testnet', leader: `0x${'55'.repeat(20)}` }).catch(() => undefined);
    expect(fakes.leaderActivity.copyActivity).toHaveBeenCalledTimes(1);
  });
});

describe('the setup deposit key (architecture review §2)', () => {
  it('is a UUID derived from the setup and the deposit it replaces, never random, and not from the revision', () => {
    const row = { id: '00000000-0000-4000-8000-0000000000aa', revision: 3, fundingOperationId: null };
    const key = setupFundingKey(row);
    expect(copyFundingInputSchema.shape.idempotencyKey.safeParse(key).success).toBe(true);
    expect(setupFundingKey(row)).toBe(key);
    // A pass after a lost step CAS (the row moved on) reserves the same deposit.
    const moved = { ...row, revision: 4 };
    expect(setupFundingKey(moved)).toBe(key);
    expect(setupFundingKey({ ...row, fundingOperationId: 'cancelled-deposit' })).not.toBe(key);
  });
  it("a start reserves its deposit under that key: two drivers of one revision reserve one deposit, not an orphan", async () => {
    const setup = await start();
    const [deposit] = await db.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, setup.consent!.fundingOperationId));
    expect(deposit!.idempotencyKey).toBe(setupFundingKey({ id: setup.id, fundingOperationId: null }));
  });
});

describe('one-click testnet copy setup', () => {
  it('start is idempotent: one strategy, wallet, agent and deposit, one consent binding every term; a mainnet leader is watched', async () => {
    const first = liveCopySetupSchema.parse(await start());
    const again = await start();
    expect(again.id).toBe(first.id);
    expect(first.stage).toBe('awaiting_consent');
    expect(first.consent).toMatchObject({ kind: 'start', leaderAddress: leader, sourceNetwork: 'mainnet', budgetUsd: '100', accountAddress, agentAddress, sweepDestination: owner.address.toLowerCase(),
      masterPolicyId: 'master-policy', fundingAmount: '100', accountAbstraction: 'disabled', builderAddress: null, builderMaxFeeTenthsOfBps: 0 });
    expect(first.consent!.agentValidUntil - first.consent!.nonce).toBeGreaterThan(29 * 86_400_000);
    expect(await db.select().from(copyStrategies)).toHaveLength(1);
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: 'testnet', status: 'paused', pauseNewRisk: true });
    expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
    expect(fakes.wallets.prepare).toHaveBeenCalledTimes(1); expect(fakes.agents.prepareForSetup).toHaveBeenCalledTimes(1);
    expect((await db.select().from(leaders)).map(row => row.address)).toEqual([leader]);
    expect(JSON.stringify(first)).not.toMatch(/owner-quorum|master-wallet|agent-wallet/);
    await expect(start('setup-start-key-000001', { budgetUsd: '200' })).rejects.toThrow('Idempotency payload changed');
  });

  it('refuses a foreign or altered consent (403) and an expired one (409); a retried start issues a fresh challenge', async () => {
    const setup = await start();
    const foreign = await sign(setup.consent!, stranger);
    await expect(service.confirm(uid, setup.id, foreign)).rejects.toMatchObject({ status: 403 });
    const altered = await sign({ ...setup.consent!, budgetUsd: '1000', fundingAmount: '1000' });
    await expect(service.confirm(uid, setup.id, altered)).rejects.toMatchObject({ status: 403 });
    later(301_000);
    await expect(service.confirm(uid, setup.id, await sign(setup.consent!))).rejects.toMatchObject({ status: 409, response: { code: 'consent_expired' } });
    const renewed = await start();
    expect(renewed.id).toBe(setup.id); expect(renewed.consent!.nonce).toBeGreaterThan(setup.consent!.nonce);
    expect(fakes.funding.submit).not.toHaveBeenCalled();
    expect((await db.select().from(copyLiveSetups))[0]!.consentDigest).toBeNull();
  });

  it("with the worker policy: confirm records the signer the owner's browser added, sends the deposit once; the worker finishes with the tab closed", async () => {
    const setup = await start();
    const confirmed = await service.confirm(uid, setup.id, await sign(setup.consent!));
    expect(confirmed).toMatchObject({ stage: 'funding_submitted' });
    expect(confirmed).not.toHaveProperty('signer'); expect(confirmed).not.toHaveProperty('pendingSignature');
    // Checked with Privy (the browser added it: only the owner can), never with the owner's session.
    expect(fakes.wallets.attachSetupSigner).toHaveBeenCalledExactlyOnceWith(uid, setup.consent!.accountId, { id: 'master-policy', fingerprint: 'c'.repeat(64) },
      { address: agentAddress, name: `copy${setup.strategyId} valid_until ${setup.consent!.agentValidUntil}` });
    expect((await db.select().from(copyExecutionAccounts))[0]).toMatchObject({ masterPolicyId: 'master-policy', masterSignerQuorumId: 'worker-quorum' });
    // A second confirm (a retried request) neither verifies nor sends again.
    await service.confirm(uid, setup.id, await sign(setup.consent!));
    expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
    // Sent as this setup's deposit: the only sender the funding rows accept for it.
    expect(fakes.funding.claim).toHaveBeenCalledExactlyOnceWith(uid, setup.consent!.fundingOperationId, { liveSetupId: setup.id });
    expect(fakes.funding.submit.mock.calls[0]![3]).toEqual({ liveSetupId: setup.id });
    later(5_000); expect(await service.tick()).toBe(1);
    expect((await service.get(uid, setup.id))).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit' });
    // The credit is looked for at most a minute later (the wait backs off).
    await credit(); later(60_000);
    await service.tick();
    const done = await service.get(uid, setup.id);
    expect(done).toMatchObject({ stage: 'running' });
    expect(workerSign).toHaveBeenCalledTimes(2);
    const [modeCall, agentCall] = workerSign.mock.calls as unknown as [[unknown, { primaryType: string; message: Record<string, unknown> }, unknown, number], [unknown, { primaryType: string; message: Record<string, unknown> }, unknown, number]];
    expect(modeCall[1]).toMatchObject({ primaryType: 'HyperliquidTransaction:UserSetAbstraction', message: { user: accountAddress, abstraction: 'disabled', hyperliquidChain: 'Testnet' } });
    expect(Object.keys(modeCall[1].message).sort()).toEqual(['abstraction', 'hyperliquidChain', 'nonce', 'user']);
    expect(modeCall[0]).toMatchObject({ workerQuorumId: 'worker-quorum', policyId: 'master-policy' });
    expect(modeCall[2]).toEqual({ network: testNetwork, account: accountAddress });
    expect(agentCall[1]).toMatchObject({ primaryType: 'HyperliquidTransaction:ApproveAgent', message: { agentAddress, agentName: `copy${setup.strategyId} valid_until ${setup.consent!.agentValidUntil}` } });
    expect(agentCall[2]).toEqual({ network: testNetwork, agent: { address: agentAddress, name: `copy${setup.strategyId} valid_until ${setup.consent!.agentValidUntil}` } });
    // The approval's own nonce was allocated first (the agent service's submit needs it).
    expect(fakes.agents.challengeRow).toHaveBeenCalledTimes(1);
    expect(agentCall[1].message.nonce).toBe(agentIntent!.nonce);
    const [mandate] = await db.select().from(copyLiveMandates);
    const consentDigest = createHash('sha256').update(JSON.stringify((await sign(setup.consent!)).consentSignature.toLowerCase())).digest('hex');
    expect(mandate).toMatchObject({ state: 'active', consentKind: 'setup', liveSetupId: setup.id, consentDigest, leaderAddress: leader, sourceNetwork: 'mainnet', budgetUsd: '100', agentAddress });
    expect((await db.select().from(copyLiveActivations))[0]).toMatchObject({ mandateId: mandate!.id, state: 'pending' });
    expect(done.mandateId).toBe(mandate!.id);
  });

  it("a confirm that finds the worker's driver holding the setup waits for it, instead of dropping the owner's signatures (Stage 2026-10-11)", async () => {
    const setup = await start();
    const repository = new CopyLiveSetupRepository(db), driver = (await repository.lease(setup.id, 60_000))!;
    const released = new Promise<void>(resolve => setTimeout(() => void repository.release(setup.id, driver.leaseToken).then(() => resolve()), 1_500));
    expect(await service.confirm(uid, setup.id, await sign(setup.consent!))).toMatchObject({ stage: 'funding_submitted' });
    await released;
    expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
  });

  it('a signer the browser added is recorded even when the consent itself is then refused (never left unrecorded on the wallet)', async () => {
    const setup = await start();
    later(301_000);
    await expect(service.confirm(uid, setup.id, await sign(setup.consent!))).rejects.toMatchObject({ status: 409, response: { code: 'consent_expired' } });
    expect(fakes.wallets.attachSetupSigner).toHaveBeenCalledTimes(1);
    expect((await db.select().from(copyExecutionAccounts))[0]).toMatchObject({ masterPolicyId: 'master-policy' });
    expect(fakes.funding.submit).not.toHaveBeenCalled();
  });

  it('starts the copy on a real clock: the generation is activated no earlier than it was created (Stage 2026-10-06)', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!));
    await credit(); later(5_000);
    // Every read of the clock moves it on, as Date.now() does: the mandate
    // step read the time before the generation row took its created_at.
    flags.ticking = true;
    await service.tick();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'running', issue: null });
    const [mandate] = await db.select().from(copyLiveMandates);
    expect(mandate!.state).toBe('active');
    expect(mandate!.activationCursor!.getTime()).toBeGreaterThanOrEqual(mandate!.createdAt.getTime());
  });
  it('never resends an attempted step: an unknown mode submission is only reconciled, then continues', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    mode.submissionState = 'unknown';
    await service.tick();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'account_mode_pending' });
    expect(fakes.modes.submit).not.toHaveBeenCalled();
    later(5_000); await service.tick();
    expect(fakes.modes.submit).not.toHaveBeenCalled();
    mode.targetState = 'supported';
    later(5_000); await service.tick();
    expect((await service.get(uid, setup.id)).stage).toBe('running');
    expect(fakes.modes.submit).not.toHaveBeenCalled();
  });

  describe('the builder fee approval: never sent is signed again, possibly sent is only observed', () => {
    const builder = `0x${'5b'.repeat(20)}`;
    let exchange: { sendAction: ReturnType<typeof vi.fn>; maxBuilderFee: ReturnType<typeof vi.fn> };
    const ok = { status: 'ok', response: { type: 'default' } };
    const driver = () => new CopyLiveSetupService(config(), new CopyLiveSetupRepository(db), new UnitOfWork(db), new CopyLiveMandateRepository(db, testConfig()), fakes.wallets as never,
      new CopyWalletRepository(db), fakes.agents as never, fakes.modes as never, fakes.funding as never, new CopyFundingRepository(db), new CopyLiveReturnRepository(db, testConfig()),
      exchange as never, { available: true, sign: workerSign } as never, () => clock, fakes.jobs, null, fakes.leaderActivity);
    const approval = async () => (await db.select().from(copyLiveBuilderApprovals))[0]!;
    const isBuilder = (data: unknown) => (data as { primaryType: string }).primaryType === 'HyperliquidTransaction:ApproveBuilderFee';
    /** A confirmed, credited setup whose next pass reaches the builder step. */
    async function atBuilder() {
      await db.update(appSettings).set({ value: adminSettingsSchema.shape.revenue.parse({ builderAddress: builder, builderFeeTenthsBps: 10 }) }).where(eq(appSettings.key, 'revenue'));
      const setup = await start();
      expect(setup.consent).toMatchObject({ builderAddress: builder, builderMaxFeeTenthsOfBps: 10 });
      await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
      return setup;
    }
    let builderSignFails = false;
    beforeEach(() => {
      exchange = { sendAction: vi.fn(async () => ok), maxBuilderFee: vi.fn(async () => 0) }; builderSignFails = false;
      workerSign.mockImplementation(async (_account: unknown, data: unknown) => {
        if (!isBuilder(data)) return `0x${'cd'.repeat(65)}`;
        if (builderSignFails) throw new Error('privy down');
        return `0x${'11'.repeat(64)}1b`;
      });
    });
    afterEach(() => { workerSign.mockImplementation(async () => `0x${'cd'.repeat(65)}`); });

    it('a builder fee the worker could not sign goes back to prepared and is retried (transient), not a failed funded setup', async () => {
      const setup = await atBuilder();
      builderSignFails = true; await driver().tick(); builderSignFails = false;
      expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'agent_active', issue: 'builder_approval_not_signed' });
      expect(await approval()).toMatchObject({ state: 'prepared', attemptedAt: null });
      expect(exchange.sendAction).not.toHaveBeenCalled();
      later(60_000); await driver().tick();
      expect(exchange.sendAction).toHaveBeenCalledTimes(1);
      expect(await approval()).toMatchObject({ state: 'accepted' });
      exchange.maxBuilderFee.mockResolvedValue(10);
      later(60_000); await driver().tick();
      expect((await service.get(uid, setup.id)).stage).toBe('running');
      expect(exchange.sendAction).toHaveBeenCalledTimes(1);
    });
    it('a builder fee refused before its POST goes back to prepared and is sent on a later pass, same nonce', async () => {
      const setup = await atBuilder();
      exchange.sendAction.mockImplementationOnce(async (_network: unknown, _body: unknown, fresh: () => void) => { fresh(); throw new LiveBoundaryError('account_action_not_dispatched'); });
      await driver().tick();
      const first = await approval();
      expect(first).toMatchObject({ state: 'prepared', attemptedAt: null });
      expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'agent_active', issue: 'account_action_not_dispatched' });
      later(60_000); await driver().tick();
      expect(exchange.sendAction).toHaveBeenCalledTimes(2);
      expect(await approval()).toMatchObject({ state: 'accepted', nonce: first.nonce });
    });
    it('a builder fee possibly sent (its answer lost) stays unknown and is never resent, only observed', async () => {
      const setup = await atBuilder();
      exchange.sendAction.mockImplementationOnce(async (_network: unknown, _body: unknown, fresh: () => void, sent: () => void) => { fresh(); sent(); throw new LiveBoundaryError('account_action_submission_unknown'); });
      await driver().tick();
      expect(await approval()).toMatchObject({ state: 'unknown', attemptedAt: expect.any(Date) });
      expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'agent_active', issue: 'builder_approval_pending' });
      later(60_000); await driver().tick();
      expect(exchange.sendAction).toHaveBeenCalledTimes(1); expect(exchange.maxBuilderFee).toHaveBeenCalled();
      expect(await approval()).toMatchObject({ state: 'unknown' });
    });
  });

  it('past its deadline nothing new is signed: the setup expires (the funds stay withdrawable)', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
    later(25 * 3_600_000);
    await service.advance(uid, setup.id);
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'expired', issue: 'setup_expired' });
    expect(workerSign).not.toHaveBeenCalled(); expect(fakes.modes.submit).not.toHaveBeenCalled();
  });

  it("a deposit Hyperliquid took but never credited ends the setup at its deadline, and no longer holds cancel or account deletion", async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!));
    later(5_000); await service.tick();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit' });
    // Before the deadline its cancel is a refund through the setup abort,
    // which this deployment (no abort worker) can't run: nothing changes.
    await expect(service.cancel(uid, setup.id)).rejects.toMatchObject({ status: 503, response: { code: 'setup_abort_unavailable' } });
    later(25 * 3_600_000); await service.tick();
    // Ended, with where the money went: sent (accepted) to the copy wallet.
    const ended = await service.get(uid, setup.id);
    expect(ended).toMatchObject({ stage: 'expired', issue: 'setup_deposit_uncredited', funding: { status: 'accepted', destination: accountAddress, amount: '100' } });
    const blockers = await db.transaction(tx => new AccountRepository(db).blockers(tx, uid));
    expect(blockers.map(blocker => blocker.code)).not.toContain('transfer_pending');
    expect(blockers.map(blocker => blocker.code)).not.toContain('setup_in_progress');
    expect((await service.cancel(uid, setup.id)).stage).toBe('cancelled');
    expect((await db.select().from(copyStrategies).where(eq(copyStrategies.id, setup.strategyId)))[0]!.status).toBe('stopped');
    // The deposit is still looked for (a credit seen later lands in the copy wallet).
    expect((await db.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, setup.consent!.fundingOperationId)))[0]!.status).toBe('accepted');
    // The main wallet's next deposit still waits for it (one pending transfer
    // per source wallet): a clean refusal, not a stuck setup.
    await expect(start('setup-start-key-000002')).rejects.toMatchObject({ status: 409, response: { code: 'funding_pending' } });
  });

  it("at the copy limit, a start left unfinished for another trader still counts, and the refusal names it to cancel", async () => {
    const abandoned = await start();
    await db.update(copyRiskPolicies).set({ limits: { ...DEFAULT_COPY_RISK_LIMITS, maxStrategiesPerUser: 1 } });
    const other = `0x${'47'.repeat(20)}`;
    const refused = await start('setup-start-key-000002', { leader: other }).catch((error: { response: unknown }) => error.response);
    expect(refused).toMatchObject({ statusCode: 409, code: 'strategy_limit', limit: 1, unfinished: [{ strategyId: abandoned.strategyId, leaderAddress: leader, setupId: abandoned.id }] });
    // Cancelled, it no longer counts.
    await service.cancel(uid, abandoned.id);
    expect((await start('setup-start-key-000003', { leader: other })).stage).toBe('awaiting_consent');
  });

  it('no step runs sooner than it was told: a busy shared Hyperliquid window is a wait until the meter said, not a failure', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    fakes.modes.submit.mockRejectedValueOnce(new HyperliquidBudgetWait(20_000, 'shared_capacity'));
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'hyperliquid_busy' });
    const [row] = await db.select().from(copyLiveSetups);
    // The wait is kept on the row (what, when, why, how many) and is never an
    // attempt: a budget wait can't use up a step's transient attempts.
    // The meter's own estimate (when the charges ahead of it expire), not a
    // blind 65 s window (a setup waited out ten of them on 2026-10-13).
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(clock + 20_000); expect(row!.nextAttemptAt!.getTime()).toBeLessThan(clock + 65_000); expect(row!.attempts).toBe(0);
    expect(row!.lastWait).toEqual({ at: new Date(clock).toISOString(), step: 'funded', reason: 'shared_capacity', retryMs: 20_000, waits: 1 });
    // Asked to drive every 3 s (and the worker's pass): nothing runs until then.
    for (let i = 0; i < 6; i++) { later(3_000); await service.advance(uid, setup.id); await service.tick(); }
    expect(fakes.modes.submit).toHaveBeenCalledTimes(1);
    later(3_000);
    expect((await service.advance(uid, setup.id)).stage).toBe('running');
    expect(fakes.modes.submit).toHaveBeenCalledTimes(2);
  });

  it('a local-budget wait says which bucket, weight and step it waited on: one warn line and the row, the API answer unchanged', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    const warn = vi.spyOn((service as unknown as { logger: { warn(message: string): void } }).logger, 'warn').mockImplementation(() => undefined);
    fakes.modes.submit.mockRejectedValueOnce(new HyperliquidBudgetWait(22_600, 'local_budget', { weight: 613, lane: 'live', bucket: 'wallet:testnet', tokens: 500, queued: 2 }));
    const answered = await service.advance(uid, setup.id);
    expect(answered).toMatchObject({ stage: 'funded', issue: 'hyperliquid_busy' }); expect(answered).not.toHaveProperty('lastWait');
    const wait = { at: new Date(clock).toISOString(), step: 'funded', reason: 'local_budget', retryMs: 22_600, waits: 1, weight: 613, lane: 'live', bucket: 'wallet:testnet', tokens: 500, queued: 2 };
    const [row] = await db.select().from(copyLiveSetups);
    expect(row).toMatchObject({ attempts: 0, lastWait: wait }); expect(row!.nextAttemptAt!.getTime()).toBe(clock + 22_600);
    const lines = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes('hyperliquid_busy'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')))).toEqual({ setupId: setup.id, attempts: 0, ...wait });
    // A second wait is counted on the wait, not as an attempt; moving on keeps the last wait.
    later(23_000); fakes.modes.submit.mockRejectedValueOnce(new HyperliquidBudgetWait(1_000, 'local_budget'));
    await service.advance(uid, setup.id);
    expect((await db.select().from(copyLiveSetups))[0]).toMatchObject({ attempts: 0, lastWait: { step: 'funded', reason: 'local_budget', retryMs: 1_000, waits: 2, at: new Date(clock).toISOString() } });
    later(2_000);
    expect((await service.advance(uid, setup.id)).stage).toBe('running');
    expect((await db.select().from(copyLiveSetups))[0]).toMatchObject({ attempts: 0, lastWait: { retryMs: 1_000 } });
  });

  // One retry policy with the copy legs and the stops (live/error-class.ts
  // decideRetry): a setup step whose provider read failed waits at least
  // 10 s like a leg, not its 3 s back-off (a burst of retries into a full
  // socket window, gate 2026-10-13 11:16). Before 2026-10-15 it waited 3 s.
  it("a setup step whose provider read failed is retried after 10 s like a leg, then by its back-off", async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    fakes.modes.submit.mockRejectedValue(new LiveBoundaryError('live_read_deadline_exceeded'));
    for (const [i, delay] of [10_000, 10_000, 12_000].entries()) {
      expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'live_read_deadline_exceeded' });
      const [row] = await db.select().from(copyLiveSetups);
      expect(row).toMatchObject({ attempts: i + 1 }); expect(row!.nextAttemptAt!.getTime()).toBe(clock + delay);
      later(delay);
    }
  });

  // A transient failure is retried with back-off and ends the setup at its
  // eighth attempt: about four minutes of retries for a real-money setup,
  // so a brief Privy or database blip never ends it (3 ended it in 9 s).
  it('a transient step failure is retried with back-off and ends the setup (failed) at its eighth attempt', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    fakes.modes.submit.mockRejectedValue(new Error('privy_unavailable'));
    const delays = [3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000];
    for (const [i, delay] of delays.entries()) {
      expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'privy_unavailable' });
      const [row] = await db.select().from(copyLiveSetups);
      expect(row).toMatchObject({ attempts: i + 1 }); expect(row!.nextAttemptAt!.getTime()).toBe(clock + delay);
      later(delay);
    }
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'failed', issue: 'privy_unavailable' });
    const [row] = await db.select().from(copyLiveSetups);
    expect(row).toMatchObject({ stage: 'failed', attempts: 8, nextAttemptAt: null });
    expect(fakes.modes.submit).toHaveBeenCalledTimes(8);
    // Ended: the worker's pass never tries it again.
    later(60_000); await service.tick();
    expect(fakes.modes.submit).toHaveBeenCalledTimes(8);
  });

  // Gate run 8 (2026-10-13): an identity proof over a slow link to Privy
  // expired every pass. A wait backed off as a transient one; at the eighth in
  // a row the owner is told (needs_owner) with one ALERT, and the setup is not
  // failed: the next proof that passes goes on.
  it('an agent identity proof that keeps expiring backs off, then waits for its owner with an ALERT instead of failing the setup', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fakes.agents.challengeRow.mockRejectedValue(new AgentIdentityEvidenceExpired());
    for (const delay of [3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000]) {
      expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'mode_set', issue: 'agent_identity_evidence_expired' });
      later(delay);
    }
    expect(alert.mock.calls.filter(call => String(call[0]).includes('ALERT'))).toHaveLength(0);
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'mode_set', issue: 'privy_identity_unverified' });
    const [row] = await db.select().from(copyLiveSetups);
    expect(row).toMatchObject({ attempts: 8 }); expect(row!.nextAttemptAt!.getTime()).toBe(clock + 15_000);
    expect(alert.mock.calls.filter(call => String(call[0]).includes('ALERT setup identity unverified'))).toHaveLength(1);
    // Still unverified: no second ALERT, still not failed.
    later(15_000);
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'mode_set', issue: 'privy_identity_unverified' });
    expect(alert.mock.calls.filter(call => String(call[0]).includes('ALERT'))).toHaveLength(1);
    // The link recovers: the next proof passes and the setup goes on.
    fakes.agents.challengeRow.mockImplementation(async (_userId: number, id: string) => {
      const [agent] = await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id));
      return { id, strategyId: agent!.strategyId, network: testNetwork, accountAddress, agentAddress, policyId: 'agent-policy', workerQuorumId: 'worker-quorum',
        nonce: clock, expiresAt: agent!.expiresAt.getTime(), consentExpiresAt: clock + 300_000 };
    });
    later(15_000);
    expect((await service.advance(uid, setup.id)).stage).not.toBe('mode_set');
  });

  it('budget waits never use up the transient attempts, and a failure without a code ends as setup_step_failed', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    fakes.modes.submit.mockRejectedValueOnce(new TypeError('x')).mockRejectedValueOnce(new HyperliquidBudgetWait(1_000, 'local_budget'))
      .mockRejectedValueOnce(new HyperliquidBudgetWait(1_000, 'local_budget')).mockRejectedValueOnce(new HyperliquidBudgetWait(1_000, 'local_budget'))
      .mockRejectedValueOnce(new TypeError('x'));
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'setup_step_pending' });
    for (let i = 0; i < 3; i++) { later(3_000); expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'hyperliquid_busy' }); }
    expect((await db.select().from(copyLiveSetups))[0]).toMatchObject({ attempts: 1, lastWait: { waits: 3 } });
    later(3_000);
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'setup_step_pending' });
    expect((await db.select().from(copyLiveSetups))[0]).toMatchObject({ attempts: 2 });
    // Attempts 3..7 fail and back off; the eighth ends the setup.
    fakes.modes.submit.mockRejectedValue(new TypeError('x'));
    for (const delay of [6_000, 12_000, 24_000, 48_000, 60_000]) {
      later(delay); expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'setup_step_pending' });
    }
    later(60_000);
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'failed', issue: 'setup_step_failed' });
    expect((await db.select().from(copyLiveSetups))[0]).toMatchObject({ attempts: 8 });
  });

  it('an outcome still unknown is reconciled past the attempt limit, never ended by count', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    const unknown = () => new LiveBoundaryError('account_action_submission_unknown');
    fakes.modes.submit.mockRejectedValueOnce(unknown()).mockRejectedValueOnce(unknown()).mockRejectedValueOnce(unknown()).mockRejectedValueOnce(unknown());
    for (let i = 0; i < 4; i++) {
      expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'account_action_submission_unknown' });
      later(60_000);
    }
    expect((await db.select().from(copyLiveSetups))[0]).toMatchObject({ attempts: 4 });
    expect((await service.advance(uid, setup.id)).stage).toBe('running');
  });

  it('past its deadline a mode submission still pending no longer holds the setup open', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    mode.submissionState = 'unknown';
    later(25 * 3_600_000);
    await service.advance(uid, setup.id);
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'expired', issue: 'setup_expired' });
    expect(fakes.modes.submit).not.toHaveBeenCalled();
  });

  it('past its deadline an agent approval still pending no longer holds the setup open', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    mode.targetState = 'supported';
    await db.update(copyAgentSetups).set({ state: 'approval_signing', consentDigest: 'a'.repeat(64), approvalNonce: clock, consentExpiresAt: new Date(clock + 300_000) });
    expect((await service.advance(uid, setup.id)).stage).toBe('mode_set');
    later(25 * 3_600_000);
    await service.advance(uid, setup.id);
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'expired', issue: 'setup_expired' });
  });

  it('cancel works only before the deposit was sent, and stops the empty strategy', async () => {
    const setup = await start();
    const cancelled = await service.cancel(uid, setup.id);
    expect(cancelled.stage).toBe('cancelled');
    expect((await db.select().from(copyFundingOperations))[0]!.status).toBe('cancelled');
    expect((await db.select().from(copyStrategies))[0]!.status).toBe('stopped');
    const second = await start('setup-start-key-000002');
    await service.confirm(uid, second.id, await sign(second.consent!));
    // Sent: cancelled only as a refund, through the setup abort (none here).
    await expect(service.cancel(uid, second.id)).rejects.toMatchObject({ status: 503, response: { code: 'setup_abort_unavailable' } });
    expect((await service.get(uid, second.id))).toMatchObject({ stage: 'funding_submitted', abortRequested: false });
  });

  it('a start whose sheet was closed (its key gone with a reload) gives way to a new start for the same leader, not already_copying', async () => {
    const abandoned = await start();
    const again = await start('setup-start-key-000002');
    expect(again).toMatchObject({ stage: 'awaiting_consent', leaderAddress: leader });
    expect(again.strategyId).not.toBe(abandoned.strategyId);
    expect(await service.get(uid, abandoned.id)).toMatchObject({ stage: 'cancelled' });
    const strategies = await db.select().from(copyStrategies);
    expect(strategies.find(row => row.id === abandoned.strategyId)!.status).toBe('stopped');
    expect(strategies.find(row => row.id === again.strategyId)!.status).toBe('paused');
    expect((await db.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, abandoned.consent!.fundingOperationId)))[0]!.status).toBe('cancelled');
    // The old sheet can't be confirmed any more.
    expect((await service.confirm(uid, abandoned.id, await sign(abandoned.consent!))).stage).toBe('cancelled');
    expect(fakes.funding.submit).not.toHaveBeenCalled();
    // A double-click (the same new key twice) is still one setup.
    expect((await start('setup-start-key-000002')).id).toBe(again.id);
  });

  it('a start that failed after its deposit arrived can be cancelled (its strategy stops, the funds stay to return) and the leader copied again', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    mode.submissionState = 'rejected';
    await service.tick();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'failed', issue: 'setup_account_mode_failed' });
    const cancelled = await service.cancel(uid, setup.id);
    expect(cancelled).toMatchObject({ stage: 'cancelled', issue: 'setup_account_mode_failed' });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'stopped', pauseNewRisk: true });
    // The deposit stays credited in the copy account (returned from the portfolio).
    expect((await db.select().from(copyFundingOperations))[0]!.status).toBe('credited');
    expect((await service.cancel(uid, setup.id)).stage).toBe('cancelled');
    mode.submissionState = 'prepared';
    expect((await start('setup-start-key-000002')).stage).toBe('awaiting_consent');
  });

  it('an expired start is ended by a new start for the same leader; a confirmed one still going is not', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
    await expect(start('setup-start-key-000002')).rejects.toMatchObject({ status: 409, response: { code: 'already_copying' } });
    await expect(service.cancel(uid, setup.id)).rejects.toMatchObject({ status: 503, response: { code: 'setup_abort_unavailable' } });
    later(25 * 3_600_000); await service.advance(uid, setup.id);
    expect((await service.get(uid, setup.id)).stage).toBe('expired');
    const again = await start('setup-start-key-000003');
    expect(again.stage).toBe('awaiting_consent');
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled', issue: 'setup_expired' });
    expect((await db.select().from(copyStrategies).where(eq(copyStrategies.id, setup.strategyId)))[0]!.status).toBe('stopped');
  });

  it("the worker reconciles an agent approval left unknown when its setup expired, once a minute at most", async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    mode.targetState = 'supported';
    const [agent] = await db.select().from(copyAgentSetups);
    await db.update(copyAgentSetups).set({ state: 'approval_unknown', consentDigest: 'a'.repeat(64), approvalNonce: clock, approvalAttemptedAt: new Date(clock), consentExpiresAt: new Date(clock + 300_000) });
    later(25 * 3_600_000); await service.advance(uid, setup.id);
    expect((await service.get(uid, setup.id)).stage).toBe('expired');
    fakes.agents.reconcile.mockClear();
    await service.tick();
    expect(fakes.agents.reconcile).toHaveBeenCalledExactlyOnceWith(uid, agent!.id);
    later(10_000); await service.tick();
    expect(fakes.agents.reconcile).toHaveBeenCalledTimes(1);
    later(60_000); await service.tick();
    expect(fakes.agents.reconcile).toHaveBeenCalledTimes(2);
    // Once it is settled (active or back to ready) nothing more is looked at.
    await db.update(copyAgentSetups).set({ state: 'ready', approvalAttemptedAt: null });
    later(60_000); await service.tick();
    expect(fakes.agents.reconcile).toHaveBeenCalledTimes(2);
    // Nor once the copy stopped (its agent can't trade; the agent service refuses a stopped copy).
    await db.update(copyAgentSetups).set({ state: 'approval_unknown', approvalAttemptedAt: new Date(clock) });
    await service.cancel(uid, setup.id);
    later(60_000); await service.tick();
    expect(fakes.agents.reconcile).toHaveBeenCalledTimes(2);
  });

  it('refuses an edit on mainnet (its new generation could never trade), before any setup row', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000); await service.tick();
    const before = await db.select().from(copyLiveSetups);
    vi.spyOn(service as unknown as { network: string }, 'network', 'get').mockReturnValue('mainnet');
    await expect(service.startEdit(uid, setup.strategyId, { idempotencyKey: 'setup-edit-key-0000001', budgetUsd: '150', settings }))
      .rejects.toMatchObject({ response: { statusCode: 409, code: 'edit_unavailable' } });
    expect(await db.select().from(copyLiveSetups)).toHaveLength(before.length);
  });
  it('an edit whose sheet was closed gives way to the next edit; an ended edit can be dismissed', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000); await service.tick();
    const abandoned = await service.startEdit(uid, setup.strategyId, { idempotencyKey: 'setup-edit-key-0000001', budgetUsd: '150', settings });
    expect(abandoned.stage).toBe('awaiting_consent');
    const next = await service.startEdit(uid, setup.strategyId, { idempotencyKey: 'setup-edit-key-0000002', budgetUsd: '120', settings });
    expect(next).toMatchObject({ stage: 'awaiting_consent', budgetUsd: '120' });
    expect((await service.get(uid, abandoned.id)).stage).toBe('cancelled');
    // An edit that expired is dismissed, not refused.
    await db.update(copyLiveSetups).set({ stage: 'expired', issue: 'setup_expired' }).where(eq(copyLiveSetups.id, next.id));
    expect((await service.cancel(uid, next.id)).stage).toBe('cancelled');
    expect((await db.select().from(copyStrategies))[0]!.status).not.toBe('stopped');
  });

  it('an edit key replays only its own payload (409 idempotency_conflict otherwise); concurrent requests with one key make one setup', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000); await service.tick();
    const body = { idempotencyKey: 'setup-edit-key-0000009', budgetUsd: '150', settings };
    const [first, second] = await Promise.all([service.startEdit(uid, setup.strategyId, body), service.startEdit(uid, setup.strategyId, body)]);
    expect(second.id).toBe(first.id);
    expect(first.stage).toBe('awaiting_consent');
    for (const changed of [{ ...body, budgetUsd: '120' }, { ...body, settings: { ...settings, maxLeverage: 2 } }])
      await expect(service.startEdit(uid, setup.strategyId, changed)).rejects.toMatchObject({ response: { statusCode: 409, code: 'idempotency_conflict' } });
    expect(await service.startEdit(uid, setup.strategyId, body)).toMatchObject({ id: first.id, stage: 'awaiting_consent', budgetUsd: '150' });
    expect((await db.select().from(copyLiveSetups)).filter(row => row.kind === 'edit')).toHaveLength(1);
  });

  it('edit: one consent, the next generation replaces the current one with the new settings and budget', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000); await service.tick();
    const [first] = await db.select().from(copyLiveMandates);
    const edit = await service.startEdit(uid, setup.strategyId, { idempotencyKey: 'setup-edit-key-0000001', budgetUsd: '150', settings: { ...settings, maxLeverage: 3 } });
    expect(edit.consent).toMatchObject({ kind: 'edit', budgetUsd: '150', fundingOperationId: '', fundingAmount: '0', agentAddress });
    later(2_000);
    const done = await service.confirm(uid, edit.id, await sign(edit.consent!));
    expect(done.stage).toBe('running');
    const rows = await db.select().from(copyLiveMandates);
    expect(rows.find(row => row.id === first!.id)!.state).toBe('expired');
    expect(rows.find(row => row.id === done.mandateId)).toMatchObject({ state: 'active', budgetUsd: '150', strategyVersion: 2, consentKind: 'setup', liveSetupId: edit.id });
    expect((await db.select().from(copyLiveStrategyConfigs))[0]).toMatchObject({ budgetUsd: '150', strategyVersion: 2 });
    expect(workerSign).toHaveBeenCalledTimes(2); // the start's mode and agent only
  });

  it('resume needs no signature: a paused generation is active again and its strategy trades', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000); await service.tick();
    const [mandate] = await db.select().from(copyLiveMandates);
    await db.update(copyLiveActivations).set({ state: 'activated', activatedAt: new Date() });
    await db.update(copyStrategies).set({ status: 'active', pauseNewRisk: false });
    const repository = new CopyLiveMandateRepository(db, testConfig()), uow = new UnitOfWork(db);
    await uow.run(tx => repository.barrier(tx, uid, mandate!.id, 'paused', () => clock));
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'paused' });
    const resumed = await uow.run(tx => repository.resume(tx, uid, mandate!.id, () => clock));
    expect(resumed.state).toBe('active');
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'active', pauseNewRisk: false });
    await db.update(copyControls).set({ pauseNewRisk: true }).where(eq(copyControls.scope, 'platform'));
    await uow.run(tx => repository.barrier(tx, uid, mandate!.id, 'paused', () => clock));
    await expect(uow.run(tx => repository.resume(tx, uid, mandate!.id, () => clock))).rejects.toMatchObject({ status: 409, response: { code: 'copy_paused' } });
  });

  it('a declined or timed-out addSigners: confirm is refused 409 worker_signer_missing before anything is deposited; a retry with the signer goes on', async () => {
    flags.attach = false;
    const setup = await start();
    const body = await sign(setup.consent!);
    await expect(service.confirm(uid, setup.id, body)).rejects.toMatchObject({ status: 409, response: { code: 'worker_signer_missing' } });
    expect(fakes.funding.claim).not.toHaveBeenCalled(); expect(fakes.funding.submit).not.toHaveBeenCalled();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'awaiting_consent' });
    expect((await db.select().from(copyFundingOperations))[0]).toMatchObject({ status: 'prepared', attemptedAt: null });
    // Retried while the consent is valid, now with the signer added.
    flags.attach = true;
    expect(await service.confirm(uid, setup.id, body)).toMatchObject({ stage: 'funding_submitted' });
    expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
  });

  it('/advance only drives the setup now: a body carrying a signature is refused 400, an empty one runs the steps with the worker', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    await expect(service.advance(uid, setup.id, { digest: `0x${'ab'.repeat(32)}`, signature: `0x${'ab'.repeat(65)}` })).rejects.toMatchObject({ status: 400 });
    expect(fakes.modes.submit).not.toHaveBeenCalled();
    expect(await service.advance(uid, setup.id, {})).toMatchObject({ stage: 'running' });
    expect(workerSign).toHaveBeenCalledTimes(2);
  });

  it('renewal is refused for now (renewal_unavailable): nothing is prepared', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000); await service.tick();
    expect((await service.get(uid, setup.id)).stage).toBe('running');
    await expect(service.startRenewal(uid, setup.strategyId, { idempotencyKey: 'setup-renew-key-000001' })).rejects.toMatchObject({ status: 409, response: { code: 'renewal_unavailable' } });
    expect(await db.select().from(copyLiveSetups)).toHaveLength(1);
    expect(fakes.agents.prepareForSetup).toHaveBeenCalledTimes(1);
  });

  it("a drive that outlives its lease leaves the next holder's lease in place when it ends", async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    // One drive is held in the mode submission (a long budget wait)...
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inSubmit = new Promise<void>(resolve => { entered = resolve; });
    const submit = fakes.modes.submit.getMockImplementation()!;
    fakes.modes.submit.mockImplementationOnce(async (...args: Parameters<typeof submit>) => { entered(); await held; return submit(...args); });
    const first = service.tick();
    await inSubmit;
    // ...past its 60 s lease, and another driver (the dialog's /advance, or a second worker) takes the setup.
    await db.update(copyLiveSetups).set({ leaseUntil: new Date(Date.now() - 1_000) }).where(eq(copyLiveSetups.id, setup.id));
    const repository = new CopyLiveSetupRepository(db);
    const next = await repository.lease(setup.id, 60_000);
    expect(next?.leaseToken).toBeTruthy();
    release(); await first;
    const [row] = await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, setup.id));
    expect(row!.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row!.leaseToken).toBe(next!.leaseToken);
    // Its own release ends it.
    await repository.release(setup.id, next!.leaseToken);
    expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, setup.id)))[0]).toMatchObject({ leaseUntil: null, leaseToken: null });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('safe abort: a driver waiting to activate cannot create a generation after the durable barrier', async () => {
  const setup = await start();
  await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const entered = deferred<void>(), release = deferred<void>();
  const original = CopyLiveMandateRepository.prototype.prepareFromSetup;
  const spy = vi.spyOn(CopyLiveMandateRepository.prototype, 'prepareFromSetup').mockImplementation(async function (this: CopyLiveMandateRepository, ...args) {
    entered.resolve(); await release.promise; return original.apply(this, args);
  });
  later(5_000); const driving = service.tick(); await entered.promise;
  const mandates = new CopyLiveMandateRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  await aborts.request(uid, setup.id, 'abort-before-generation-key', () => clock);
  release.resolve(); await driving; spy.mockRestore();
  expect(await db.select().from(copyLiveMandates)).toHaveLength(0);
  expect((await service.get(uid, setup.id)).stage).not.toBe('running');
});

it('safe abort: reload reads the permanent abort authority and no longer offers the old consent', async () => {
  const setup = await start();
  const mandates = new CopyLiveMandateRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  await aborts.request(uid, setup.id, 'abort-reload-original-key', () => clock);
  expect(await service.get(uid, setup.id)).toMatchObject({ abortRequested: true, consent: null, stage: 'awaiting_consent' });
  expect(await service.recover(uid, 'setup-start-key-000001')).toMatchObject({ abortRequested: true, consent: null });
  expect(await service.confirm(uid, setup.id, await sign(setup.consent!))).toMatchObject({ abortRequested: true, consent: null });
  expect(fakes.funding.submit).not.toHaveBeenCalled();
});

it('safe abort: verified consent is durable before the original deposit attempt without pretending confirmation finished', async () => {
  const setup = await start(), signatures = await sign(setup.consent!);
  const entered = deferred<void>(), release = deferred<void>(), original = fakes.funding.submit.getMockImplementation()!;
  fakes.funding.submit.mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return original(...args);
  });
  const confirming = service.confirm(uid, setup.id, signatures); await entered.promise;
  const [row] = await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, setup.id));
  release.resolve(); await confirming;
  expect(row).toMatchObject({ consentDigest: createHash('sha256').update(JSON.stringify(signatures.consentSignature.toLowerCase())).digest('hex'),
    confirmedAt: null, stage: 'awaiting_consent', fundingOperationId: setup.consent!.fundingOperationId });
});

it('safe abort: a reserved deposit belongs to the original setup before its parent can record the returned child id', async () => {
  let reservationParent: string | null | undefined;
  const reserve = fakes.funding.reserve.getMockImplementation()!;
  fakes.funding.reserve.mockImplementationOnce(async (...args) => {
    const wire = await reserve(...args);
    reservationParent = (await db.select().from(copyFundingOperations).where(eq(copyFundingOperations.id, wire.id)))[0]!.liveSetupId;
    return wire;
  });
  const setup = await start();
  expect(reservationParent).toBe(setup.id);
});

function flatAbortProof(): SetupAbortFlatObservation {
  return { purpose: 'setup-abort-return', snapshot: { network: testNetwork, accountAddress, role: 'user', accountAbstraction: 'default',
    observedAt: clock, completedAt: clock, sourceDigest: 'd'.repeat(64), collateralToken: 0, collateralCoin: 'USDC', perpEquity: '100', totalMarginUsed: '0',
    withdrawable: '100', exposureUsd: '0', restingExposureUsd: '0', grossRestingExposureUsd: '0', positions: [], restingOrders: [],
    dexes: [{ dex: '', perpDexIndex: 0, supported: true, collateralToken: 0, collateralCoin: 'USDC', providerTime: clock, equity: '100', rawUsd: '100',
      marginUsed: '0', withdrawable: '100', exposureUsd: '0', crossEquity: '100', crossMarginUsed: '0', crossExposureUsd: '0', crossMaintenanceMarginUsed: '0' }],
    coverage: { complete: true, balanceComplete: true, orderComplete: true, listedDexes: [''], observedOrderDexes: [''], unobservedOrderDexes: [], earliestProviderTime: clock } } };
}

it('safe abort: zero balance alone cannot complete while the original deposit is still accepted', async () => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!));
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const requested = await aborts.request(uid, setup.id, 'abort-zero-pending-deposit-key', () => clock), authority = (await aborts.lease(requested.id))!;
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), proof = flatAbortProof();
  Object.assign(proof.snapshot, { withdrawable: '0', perpEquity: '0' });
  Object.assign(proof.snapshot.dexes[0]!, { equity: '0', rawUsd: '0', withdrawable: '0', crossEquity: '0' });
  expect(await refunds.complete(authority, proof, () => clock)).toBe(false);
  expect((await aborts.find(uid, authority.id)).state).not.toBe('done');
  // A late credit belongs to this original operation, never to a new deposit.
  await credit();
  expect(await refunds.complete(authority, flatAbortProof(), () => clock)).toBe(false);
  expect((await refunds.reserve(authority, flatAbortProof(), () => clock))!.setupAbortId).toBe(authority.id);
});

it('safe abort: proven zero with the original deposit resolved can complete without inventing a return or stop', async () => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const requested = await aborts.request(uid, setup.id, 'abort-already-zero-original-key', () => clock), authority = (await aborts.lease(requested.id))!;
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), proof = flatAbortProof();
  Object.assign(proof.snapshot, { withdrawable: '0', perpEquity: '0' });
  Object.assign(proof.snapshot.dexes[0]!, { equity: '0', rawUsd: '0', withdrawable: '0', crossEquity: '0' });
  expect(await refunds.complete(authority, proof, () => clock)).toBe(true);
  expect(await aborts.find(uid, authority.id)).toMatchObject({ state: 'done', returnOperationId: null, stopId: null });
  expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled', abortRequested: true });
});

it.each(['policy_unknown', 'wallet_unknown'] as const)('safe abort: expired driver plus fresh zero cannot clear an unresolved %s SDK child', async state => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  await db.update(copyLiveSetups).set({ leaseToken: 'paused-original-driver', leaseUntil: new Date(Date.now() - 1) }).where(eq(copyLiveSetups.id, setup.id));
  await db.update(copyAgentSetups).set({ state }).where(eq(copyAgentSetups.liveSetupId, setup.id));
  const requested = await aborts.request(uid, setup.id, 'abort-sdk-unknown-original-key', () => clock), authority = (await aborts.lease(requested.id))!;
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), proof = flatAbortProof();
  Object.assign(proof.snapshot, { withdrawable: '0', perpEquity: '0' });
  Object.assign(proof.snapshot.dexes[0]!, { equity: '0', rawUsd: '0', withdrawable: '0', crossEquity: '0' });
  expect(await refunds.complete(authority, proof, () => clock)).toBe(false);
  expect((await new CopyLiveSetupRepository(db).find(uid, setup.id)).leaseToken).toBe('paused-original-driver');
  expect((await aborts.find(uid, authority.id)).state).not.toBe('done');
});

it('safe abort: a never-attempted original deposit can cancel with fresh zero proof but cannot authorize a refund without genuine consent', async () => {
  const setup = await start();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const requested = await aborts.request(uid, setup.id, 'abort-unfunded-original-key', () => clock), authority = (await aborts.lease(requested.id))!;
  await new CopyFundingRepository(db).cancel(uid, setup.consent!.fundingOperationId);
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), proof = flatAbortProof();
  Object.assign(proof.snapshot, { withdrawable: '0', perpEquity: '0' });
  Object.assign(proof.snapshot.dexes[0]!, { equity: '0', rawUsd: '0', withdrawable: '0', crossEquity: '0' });
  await expect(refunds.reserve(authority, flatAbortProof(), () => clock)).rejects.toMatchObject({ response: { code: 'setup_abort_binding_unknown' } });
  expect(await refunds.complete(authority, proof, () => clock)).toBe(true);
  expect((await service.get(uid, setup.id)).stage).toBe('cancelled');
  expect((await db.select().from(copyFundingOperations)).filter(row => row.direction === 'to_main')).toHaveLength(0);
});

it('safe abort: lost answers and concurrent passes preserve one original proof-bound refund and one attempt', async () => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const requested = await aborts.request(uid, setup.id, 'abort-refund-original-key', () => clock), authority = (await aborts.lease(requested.id))!;
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
  const [first, second] = await Promise.all([refunds.reserve(authority, flatAbortProof(), () => clock), refunds.reserve(authority, flatAbortProof(), () => clock)]);
  expect(first).not.toBeNull(); expect(second!.id).toBe(first!.id);
  expect(first).toMatchObject({ direction: 'to_main', setupAbortId: authority.id, stopId: null, destination: owner.address.toLowerCase(), amount: '100' });
  const current = await aborts.find(uid, authority.id);
  const restarted = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
  expect((await restarted.reserve(current, flatAbortProof(), () => clock))!.id).toBe(first!.id);
  const attempts = await Promise.all([refunds.begin(current, first!.id, flatAbortProof(), () => clock), restarted.begin(current, first!.id, flatAbortProof(), () => clock)]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect((await db.select().from(copyFundingOperations)).filter(row => row.setupAbortId === authority.id)).toHaveLength(1);
  // The ordinary owner approval endpoint cannot bypass this dedicated proof.
  await expect(returns.begin(uid, first!.id)).rejects.toMatchObject({ response: { code: 'setup_abort_return_requires_proof' } });
});

it('safe abort: a proof that ages before refund admission never creates a transfer attempt', async () => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const requested = await aborts.request(uid, setup.id, 'abort-refund-stale-proof-key', () => clock), authority = (await aborts.lease(requested.id))!;
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), proof = flatAbortProof();
  const row = (await refunds.reserve(authority, proof, () => clock))!;
  later(5_001);
  await expect(refunds.begin(await aborts.find(uid, authority.id), row.id, proof, () => clock)).rejects.toMatchObject({ response: { code: 'setup_abort_proof_stale' } });
  expect((await returns.find(uid, row.id)).attemptedAt).toBeNull();
});

it('safe abort: a refund never handed to the exchange goes back to prepared with its nonce and is sent on a later pass; a slow signature is proven again; a possibly-sent one is never resent', async () => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
  const observer = { observeSetupAbortFlat: vi.fn(async () => flatAbortProof()) };
  const ok = { status: 'ok', response: { type: 'default' } };
  const exchange = { acquire: vi.fn(async () => undefined), send: vi.fn(async (_op: unknown, _sig: string, fresh: () => void, dispatched: () => void) => { fresh(); dispatched(); return ok; }) };
  const signer = { available: true, sign: vi.fn(async () => 'test-worker-signature') };
  const worker = () => new CopyLiveSetupAbortService(config(), aborts, refunds, new CopyLiveSetupRepository(db), new CopyFundingRepository(db),
    fakes.funding as never, fakes.agents as never, fakes.modes as never, {} as never, returns, exchange as never, signer as never, observer as never, new BackgroundJobs(), () => clock);
  const requested = await worker().request(uid, setup.id, { idempotencyKey: 'abort-refund-not-dispatched-key' });
  const due = () => db.update(copyLiveSetupAborts).set({ nextAttemptAt: null }).where(eq(copyLiveSetupAborts.id, requested.id));
  // Refused before its POST (the meter): nothing left, it is prepared again.
  exchange.send.mockImplementationOnce(async (_op: unknown, _sig: string, fresh: () => void) => { fresh(); throw new Error('hyperliquid_quota_expired'); });
  await worker().process(requested.id);
  const refundId = (await aborts.find(uid, requested.id)).returnOperationId!, first = await returns.find(uid, refundId);
  expect(first).toMatchObject({ status: 'prepared', attemptedAt: null, claimedAt: null, setupAbortId: requested.id });
  expect((await aborts.find(uid, requested.id))).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
  // A later pass, whose signature takes 4 s: proven again, then sent once, same refund and nonce.
  await due(); later(1_000);
  signer.sign.mockImplementationOnce(async () => { later(4_000); return 'test-worker-signature'; });
  await worker().process(requested.id);
  // Pass 1: reservation and begin proofs; pass 2: begin proof, then again after the slow signature.
  expect(observer.observeSetupAbortFlat).toHaveBeenCalledTimes(4);
  expect(exchange.send).toHaveBeenCalledTimes(2);
  expect(await returns.find(uid, refundId)).toMatchObject({ status: 'accepted', nonce: first.nonce });
  expect((await db.select().from(copyFundingOperations)).filter(row => row.setupAbortId === requested.id)).toHaveLength(1);
  // Possibly sent (its answer lost): it stays unknown and is never resent.
  await db.update(copyFundingOperations).set({ status: 'prepared', attemptedAt: null, claimedAt: null, evidenceHash: null }).where(eq(copyFundingOperations.id, refundId));
  await due();
  exchange.send.mockImplementationOnce(async (_op: unknown, _sig: string, fresh: () => void, dispatched: () => void) => { fresh(); dispatched(); throw new Error('socket hang up'); });
  await worker().process(requested.id);
  expect(await returns.find(uid, refundId)).toMatchObject({ status: 'unknown', attemptedAt: expect.any(Date) });
  await due(); await worker().process(requested.id);
  expect(exchange.send).toHaveBeenCalledTimes(3);
  expect(await returns.find(uid, refundId)).toMatchObject({ status: 'unknown' });
});

it.each(['late-credit', 'prepared-deposit', 'claimed-deposit', 'prepared-return'] as const)('safe abort: worker restart seals original driver and the unattempted ordinary %s before one verified refund', async ordinaryKind => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!));
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
  const observer = { observeSetupAbortFlat: vi.fn(async () => flatAbortProof()) };
  // The copy account's balance read: the late credit has not landed yet.
  const exchange = { acquire: vi.fn(async () => undefined), withdrawable: vi.fn(async () => '0'), send: vi.fn(async (_op: unknown, _sig: string, fresh: () => void, dispatched: () => void) => {
    fresh(); dispatched(); return { status: 'ok', response: { type: 'default' } };
  }) };
  const signer = { available: true, sign: vi.fn(async () => 'test-worker-signature') };
  const createWorker = () => new CopyLiveSetupAbortService(config(), aborts, refunds, new CopyLiveSetupRepository(db), new CopyFundingRepository(db),
    fakes.funding as never, fakes.agents as never, fakes.modes as never, {} as never, returns, exchange as never, signer as never, observer as never, new BackgroundJobs(), () => clock);
  const oldDriver = (await new CopyLiveSetupRepository(db).lease(setup.id, 60_000))!;
  await db.update(copyLiveSetups).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(copyLiveSetups.id, setup.id));
  const parent = await new CopyLiveSetupRepository(db).find(uid, setup.id), direction = ordinaryKind === 'prepared-return' ? 'to_main' : 'to_account';
  const fundingRows = new CopyFundingRepository(db);
  let ordinary: Awaited<ReturnType<CopyFundingRepository['find']>> | null = null;
  if (ordinaryKind !== 'late-credit') {
    await credit();
    // Admit the actual ordinary operation BEFORE the barrier, using the same
    // production repository and account-wide pending guards as the UI.
    ordinary = direction === 'to_account'
      ? await fundingRows.reserve(uid, parent.accountId!, testNetwork, { idempotencyKey: 'ordinary-never-attempted-transfer-key', amount: '1' })
      : await returns.reserve(uid, parent.accountId!, { idempotencyKey: 'ordinary-never-attempted-transfer-key', amount: '1', sweep: false });
    if (ordinaryKind === 'claimed-deposit') ordinary = (await fundingRows.claim(uid, ordinary.id)).row;
  }
  const requested = await createWorker().request(uid, setup.id, { idempotencyKey: 'abort-worker-original-key' });
  if (ordinary) {
    const holder = (await aborts.lease(requested.id))!;
    // A stale worker or a differently bound child cannot use the sealing
    // authority, even when the presented transfer has no attempt timestamp.
    expect(await aborts.sealOrdinaryFunding({ ...holder, leaseToken: 'stale-holder' }, ordinary)).toBe(false);
    expect(await aborts.sealOrdinaryFunding(holder, { ...ordinary, liveSetupId: setup.id })).toBe(false);
    expect(await aborts.sealOrdinaryFunding(holder, { ...ordinary, attemptedAt: new Date(clock) })).toBe(false);
    expect(await aborts.sealOrdinaryFunding(holder, { ...ordinary, destination: '0x' + '9'.repeat(40) })).toBe(false);
    expect((await fundingRows.find(uid, ordinary.id)).status).toBe(ordinary.status);
    await aborts.release(holder);
  }
  if (ordinaryKind === 'late-credit') {
    await createWorker().process(requested.id);
    expect((await aborts.find(uid, requested.id)).state).toBe('waiting_credit');
    expect(exchange.send).not.toHaveBeenCalled(); expect(observer.observeSetupAbortFlat).not.toHaveBeenCalled();
    await credit();
  }
  // A due pass after process restart reads the original credit and authority.
  await createWorker().process(requested.id);
  if (ordinary) expect(await fundingRows.find(uid, ordinary.id)).toMatchObject({ status: 'cancelled', attemptedAt: null });
  const authority = await aborts.find(uid, requested.id), refund = await returns.find(uid, authority.returnOperationId!);
  expect(refund.status).toBe('accepted'); expect(exchange.send).toHaveBeenCalledTimes(1);
  if (ordinary && direction === 'to_account') await expect(fundingRows.beginSubmit(uid, ordinary.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  else if (ordinary) await expect(returns.begin(uid, ordinary.id)).rejects.toMatchObject({ response: { code: 'setup_abort_requested' } });
  expect((await new CopyLiveSetupRepository(db).find(uid, setup.id)).leaseToken).toBe(oldDriver.leaseToken);
  await createWorker().process(requested.id);
  expect(exchange.send).toHaveBeenCalledTimes(1);
  expect((await aborts.find(uid, requested.id)).state).not.toBe('done');
  await db.update(copyFundingOperations).set({ status: 'credited', transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '100', fee: '0', evidenceHash: 'e'.repeat(64) })
    .where(eq(copyFundingOperations.id, refund.id));
  observer.observeSetupAbortFlat.mockImplementation(async () => {
    const proof = flatAbortProof(); Object.assign(proof.snapshot, { withdrawable: '0', perpEquity: '0' });
    Object.assign(proof.snapshot.dexes[0]!, { equity: '0', rawUsd: '0', withdrawable: '0', crossEquity: '0' }); return proof;
  });
  // An ordinary top-up had already crossed its SDK attempt boundary. Its
  // receipt must be reconciled too; neither zero nor the original refund's
  // receipt seals another unresolved transfer on this account.
  await db.insert(copyFundingOperations).values({ id: 'plain-delayed-topup', userId: uid, accountId: authority.accountId!, strategyId: authority.strategyId,
    network: authority.network, address: authority.destination, destination: authority.accountAddress!, direction: 'to_account', amount: '1',
    idempotencyKey: 'plain-delayed-topup-original-key', nonce: clock + 100, status: 'accepted', attemptedAt: new Date(clock), claimedAt: new Date(clock), evidenceHash: 'a'.repeat(64) });
  await createWorker().process(requested.id);
  expect((await aborts.find(uid, requested.id)).state).not.toBe('done');
  expect(fakes.funding.reconcile).toHaveBeenCalledWith(uid, 'plain-delayed-topup');
  expect(exchange.send).toHaveBeenCalledTimes(1);
  await db.update(copyFundingOperations).set({ status: 'credited', transactionHash: `0x${'c'.repeat(64)}`, creditedAmount: '1', fee: '0', evidenceHash: 'e'.repeat(64) })
    .where(eq(copyFundingOperations.id, 'plain-delayed-topup'));
  await createWorker().process(requested.id);
  expect((await aborts.find(uid, requested.id)).state).toBe('done');
  expect(await new CopyLiveSetupRepository(db).find(uid, setup.id)).toMatchObject({ stage: 'cancelled', leaseToken: null, leaseUntil: null });
  expect(await new CopyLiveSetupRepository(db).transition(oldDriver, { stage: 'funded' })).toBeNull();
  expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
  expect(exchange.send).toHaveBeenCalledTimes(1);
  expect(await db.select().from(copyLiveMandates)).toHaveLength(0);
});

// These tests pause provider work, not SQL. The HTTP answer must settle
// before its 20-second deadline while the same durable operation survives.
it('request recovery: slow provisioning answers with its admitted original id before the HTTP deadline', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const prepare = fakes.wallets.prepare.getMockImplementation()!;
  let providerSignal: AbortSignal | undefined;
  fakes.wallets.prepare.mockImplementationOnce(async (...args) => {
    providerSignal = currentRequestSignal(); entered.resolve(); await release.promise; return prepare(...args);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const request = new AbortController();
  let answer: Awaited<ReturnType<typeof start>> | undefined;
  const pending = withRequestSignal(request.signal, () => start().then(value => { answer = value; return value; }));
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10_001);
  for (let i = 0; i < 50 && !answer; i++) await yieldIo(10);
  // Capture before releasing the provider: awaiting an inline handler would
  // otherwise hide the precise regression.
  const early = answer;
  const rows = await db.select().from(copyLiveSetups);
  request.abort(); release.resolve();
  await pending; vi.useRealTimers();
  await vi.waitFor(async () => expect((await service.get(uid, rows[0]!.id)).stage).toBe('awaiting_consent'));
  expect(early).toMatchObject({ id: rows[0]!.id, stage: 'provisioning', consent: null });
  expect(providerSignal).toBeUndefined();
  expect(await db.select().from(copyLiveSetups)).toHaveLength(1);
  expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
});

it('request recovery: slow confirmation answers with the original id and submits its deposit only once', async () => {
  const prepared = await start(), signatures = await sign(prepared.consent!);
  const entered = deferred<void>(), release = deferred<void>();
  const submit = fakes.funding.submit.getMockImplementation()!;
  fakes.funding.submit.mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return submit(...args);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let answer: Awaited<ReturnType<typeof start>> | undefined;
  const pending = service.confirm(uid, prepared.id, signatures).then(value => { answer = value; return value; });
  await entered.promise; await vi.advanceTimersByTimeAsync(10_001);
  for (let i = 0; i < 50 && !answer; i++) await yieldIo(10);
  const early = answer;
  release.resolve(); await pending; vi.useRealTimers();
  await vi.waitFor(async () => expect((await service.get(uid, prepared.id)).stage).toBe('funding_submitted'));
  const retry = await service.confirm(uid, prepared.id, signatures);
  expect(early).toMatchObject({ id: prepared.id });
  expect(retry).toMatchObject({ id: prepared.id, stage: 'funding_submitted' });
  expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
  expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
});

it('request recovery: advance bounds deposit reconciliation as well as its driver', async () => {
  const prepared = await start(); await service.confirm(uid, prepared.id, await sign(prepared.consent!));
  const entered = deferred<void>(), release = deferred<void>();
  fakes.funding.reconcile.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let answer: Awaited<ReturnType<typeof start>> | undefined;
  const pending = service.advance(uid, prepared.id).then(value => { answer = value; return value; });
  await entered.promise; await vi.advanceTimersByTimeAsync(10_001);
  for (let i = 0; i < 50 && !answer; i++) await yieldIo(10);
  const early = answer;
  release.resolve(); await pending; vi.useRealTimers();
  expect(early).toMatchObject({ id: prepared.id, stage: 'funding_submitted' });
  expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
});

it('request recovery: original-key lookup is read-only and scoped to the owner and deployment network', async () => {
  const prepared = await start();
  const before = await db.select().from(copyLiveSetups);
  expect(await service.recover(uid, 'setup-start-key-000001')).toEqual(await service.get(uid, prepared.id));
  const other = (await insertUser(db, { privyUserId: 'did:privy:other-setup-owner' })).id;
  await expect(service.recover(other, 'setup-start-key-000001')).rejects.toMatchObject({ status: 404 });
  await db.update(copyStrategies).set({ network: 'mainnet' }).where(eq(copyStrategies.id, prepared.strategyId));
  await expect(service.recover(uid, 'setup-start-key-000001')).rejects.toMatchObject({ status: 404 });
  expect(await db.select().from(copyLiveSetups)).toEqual(before);
  expect(fakes.funding.submit).not.toHaveBeenCalled();
});

it('request recovery: the public wire contract validates the original setup recovery answer', async () => {
  const prepared = await start();
  const contract = findHttpContract('GET', '/me/copy/live/setups/by-key/setup-start-key-000001');
  expect(contract).toBeDefined();
  expect(contract!.response.parse(prepared)).toEqual(prepared);
});

it('request recovery: retrying a key admitted on another deployment cannot provision or replace it', async () => {
  const prepared = await start();
  await db.update(copyStrategies).set({ network: 'mainnet' }).where(eq(copyStrategies.id, prepared.strategyId));
  await expect(start()).rejects.toMatchObject({ status: 404 });
  expect(await db.select().from(copyLiveSetups)).toHaveLength(1);
  expect(fakes.wallets.prepare).toHaveBeenCalledTimes(1);
  expect(fakes.funding.submit).not.toHaveBeenCalled();
});

it('request recovery: HTTP recovery is no-store, owner-only and strictly read-only', async () => {
  const prepared = await start();
  await insertUser(db, { privyUserId: 'did:privy:recovery-other' });
  const { app } = await createAuthedApp({ db,
    privy: stubPrivy({ alice: { privyUserId: 'did:privy:setup-owner' }, bob: { privyUserId: 'did:privy:recovery-other' } }),
    controllers: [CopyLiveSetupController], providers: [{ provide: CopyLiveSetupService, useValue: service }] });
  const path = '/me/copy/live/setups/by-key/setup-start-key-000001';
  const before = await db.select().from(copyLiveSetups);
  try {
    const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer alice').expect(200).expect('Cache-Control', 'no-store');
    expect(liveCopySetupSchema.parse(response.body.data)).toEqual(prepared);
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer bob').expect(404);
    await request(app.getHttpServer()).get('/me/copy/live/setups/by-key/short').set('Authorization', 'Bearer alice').expect(400);
    expect(await db.select().from(copyLiveSetups)).toEqual(before);
    expect(fakes.wallets.prepare).toHaveBeenCalledTimes(1);
    expect(fakes.funding.submit).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('safe abort: HTTP establishes one original authority without signatures, provider work or client-selected refund fields', async () => {
  const prepared = await start(), mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const observer = { observeSetupAbortFlat: vi.fn(async () => flatAbortProof()) }, exchange = { acquire: vi.fn(), send: vi.fn() }, signer = { available: true, sign: vi.fn() };
  const worker = new CopyLiveSetupAbortService(config(), aborts, new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), new CopyLiveSetupRepository(db),
    new CopyFundingRepository(db), fakes.funding as never, fakes.agents as never, fakes.modes as never, {} as never, returns, exchange as never, signer as never, observer, new BackgroundJobs(), () => clock);
  await insertUser(db, { privyUserId: 'did:privy:abort-other' });
  const { app } = await createAuthedApp({ db, privy: stubPrivy({ alice: { privyUserId: 'did:privy:setup-owner' }, bob: { privyUserId: 'did:privy:abort-other' } }),
    controllers: [CopyLiveSetupController], providers: [{ provide: CopyLiveSetupService, useValue: service }, { provide: CopyLiveSetupAbortService, useValue: worker }] });
  const path = `/me/copy/live/setups/${prepared.id}/abort`, body = { idempotencyKey: 'abort-http-original-key' };
  try {
    const first = await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer alice').send(body).expect(200).expect('Cache-Control', 'no-store');
    const saved = liveCopySetupAbortSchema.parse(first.body.data);
    expect(saved).toMatchObject({ setupId: prepared.id, state: 'requested', refund: null, stop: null });
    const second = await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer alice').send(body).expect(200);
    expect(second.body.data.id).toBe(saved.id);
    const read = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer alice').expect(200).expect('Cache-Control', 'no-store');
    expect(read.body.data.id).toBe(saved.id);
    await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer alice').send({ ...body, destination: owner.address }).expect(400);
    await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer alice').send({ ...body, amount: '100' }).expect(400);
    await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer bob').send(body).expect(404);
    await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer bob').expect(404);
    await request(app.getHttpServer()).get(path).expect(401);
    expect(observer.observeSetupAbortFlat).not.toHaveBeenCalled(); expect(signer.sign).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
    expect(fakes.funding.submit).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('request recovery: HTTP sends one bounded answer while slow preparation survives the original request deadline', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const prepare = fakes.wallets.prepare.getMockImplementation()!;
  fakes.wallets.prepare.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return prepare(...args); });
  const { app } = await createAuthedApp({ db, privy: stubPrivy({ alice: { privyUserId: 'did:privy:setup-owner' } }),
    controllers: [CopyLiveSetupController], providers: [{ provide: CopyLiveSetupService, useValue: service }],
    beforeListen: app => app.use(requestContext(fakes.jobs)) });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let answer: { status: number; body: { data: unknown } } | undefined;
  const pending = request(app.getHttpServer()).post('/me/copy/live/setups').set('Authorization', 'Bearer alice')
    .send({ idempotencyKey: 'http-original-request-0001', leader, budgetUsd: '100', settings })
    .then(response => { answer = response; return response; });
  try {
    await entered.promise; await vi.advanceTimersByTimeAsync(10_001);
    for (let i = 0; i < 50 && !answer; i++) await yieldIo(10);
    const early = answer;
    await vi.advanceTimersByTimeAsync(20_000);
    release.resolve(); await pending; vi.useRealTimers();
    const row = (await db.select().from(copyLiveSetups))[0]!;
    await vi.waitFor(async () => expect((await service.get(uid, row.id)).stage).toBe('awaiting_consent'));
    expect(early?.status).toBe(200);
    expect(liveCopySetupSchema.parse(early?.body.data)).toMatchObject({ id: row.id, stage: 'provisioning' });
    expect(await db.select().from(copyLiveSetups)).toHaveLength(1);
    expect(fakes.funding.submit).not.toHaveBeenCalled();
  } finally { release.resolve(); vi.useRealTimers(); await pending; await fakes.jobs.drain(1000); await app.close(); }
});

it('request recovery: concurrent original-key retries share the provisioning lease', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const prepare = fakes.wallets.prepare.getMockImplementation()!;
  fakes.wallets.prepare.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return prepare(...args); });
  const first = start(); await entered.promise;
  const retry = await start();
  release.resolve(); await first;
  expect(fakes.wallets.prepare).toHaveBeenCalledTimes(1);
  expect(retry.stage).toBe('provisioning');
  expect(await db.select().from(copyLiveSetups)).toHaveLength(1);
  expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
});

it('request recovery: a restarted worker resumes admitted provisioning without another request or deposit', async () => {
  fakes.wallets.prepareSetupPolicy.mockResolvedValueOnce(null);
  const admitted = await start();
  expect(admitted).toMatchObject({ stage: 'provisioning', issue: 'worker_policy_pending', consent: null });
  await fakes.jobs.drain(1000);
  fakes = build();
  await service.tick();
  expect((await service.recover(uid, 'setup-start-key-000001')).id).toBe(admitted.id);
  expect((await service.get(uid, admitted.id)).stage).toBe('awaiting_consent');
  expect(await db.select().from(copyLiveSetups)).toHaveLength(1);
  expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
  expect(fakes.wallets.prepare).not.toHaveBeenCalled();
  expect(fakes.funding.submit).not.toHaveBeenCalled();
});

it('request recovery review: cancellation stops deferred provisioning before any new child preparation', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const prepare = fakes.wallets.prepare.getMockImplementation()!;
  fakes.wallets.prepare.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return prepare(...args); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = start(); await entered.promise; await vi.advanceTimersByTimeAsync(10_001);
  const admitted = await pending;
  await service.cancel(uid, admitted.id);
  release.resolve(); vi.useRealTimers(); await fakes.jobs.drain(1000);
  expect(await service.get(uid, admitted.id)).toMatchObject({ stage: 'cancelled', consent: null, issue: null });
  expect(fakes.agents.prepareForSetup).not.toHaveBeenCalled();
  expect(fakes.funding.reserve).not.toHaveBeenCalled();
});

it('request recovery review: an old driver failure cannot overwrite an already cancelled terminal setup', async () => {
  const prepared = await start(); await service.confirm(uid, prepared.id, await sign(prepared.consent!)); await credit(); later(5000);
  const entered = deferred<void>(), release = deferred<void>();
  fakes.modes.submit.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ...mode, submissionState: 'rejected' }; });
  const old = service.tick(); await entered.promise;
  await db.update(copyLiveSetups).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(copyLiveSetups.id, prepared.id));
  later(86_400_000); await service.tick();
  expect((await service.get(uid, prepared.id)).stage).toBe('expired');
  await service.cancel(uid, prepared.id);
  release.resolve(); await old;
  expect((await service.get(uid, prepared.id)).stage).toBe('cancelled');
});

it('request recovery review: cancel checks deposit admission under the same user lock as beginSubmit', async () => {
  const prepared = await start(), fundingRows = new CopyFundingRepository(db);
  const entered = deferred<void>(), release = deferred<void>();
  const original = CopyLiveMandateRepository.prototype.lock;
  const spy = vi.spyOn(CopyLiveMandateRepository.prototype, 'lock').mockImplementationOnce(async function(this: CopyLiveMandateRepository, ...args: Parameters<typeof original>) {
    entered.resolve(); await release.promise; return original.call(this, ...args);
  });
  const cancelling = service.cancel(uid, prepared.id).catch(error => error);
  await entered.promise;
  // As the setup's confirm sends it (the only sender of a setup's deposit).
  await fundingRows.claim(uid, prepared.consent!.fundingOperationId, { liveSetupId: prepared.id });
  await fundingRows.beginSubmit(uid, prepared.consent!.fundingOperationId, { liveSetupId: prepared.id });
  release.resolve(); const result = await cancelling; spy.mockRestore();
  expect(result).toMatchObject({ status: 409, response: { code: 'funding_pending' } });
  expect((await service.get(uid, prepared.id)).stage).toBe('awaiting_consent');
  expect(fakes.funding.submit).not.toHaveBeenCalled();
});

it('request recovery review: a slow explicit retry cannot reuse the previous unsent funding evidence', async () => {
  const prepared = await start(), signatures = await sign(prepared.consent!);
  const rows = new CopyFundingRepository(db);
  const submit = fakes.funding.submit.getMockImplementation()!;
  fakes.funding.submit.mockImplementationOnce(async (userId, id) => {
    await rows.restoreUnsent(userId, id);
    return fundingWire(await rows.find(userId, id));
  });
  expect(await service.confirm(uid, prepared.id, signatures)).toMatchObject({ stage: 'awaiting_consent', issue: 'funding_not_submitted' });
  const entered = deferred<void>(), release = deferred<void>();
  fakes.funding.submit.mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return submit(...args);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let answer: Awaited<ReturnType<typeof start>> | undefined;
  const pending = service.confirm(uid, prepared.id, signatures).then(value => { answer = value; return value; });
  await entered.promise; await vi.advanceTimersByTimeAsync(10_001);
  for (let i = 0; i < 50 && !answer; i++) await yieldIo(10);
  const early = answer;
  release.resolve(); await pending; vi.useRealTimers();
  await vi.waitFor(async () => expect((await service.get(uid, prepared.id)).stage).toBe('funding_submitted'));
  expect(early).toMatchObject({ id: prepared.id, stage: 'awaiting_consent', issue: null });
  expect(await db.select().from(copyFundingOperations)).toHaveLength(1);
  expect(fakes.funding.submit).toHaveBeenCalledTimes(2);
});

it('mainnet recovery fences setup, reserves one original refund, and rejects wrong-network or stale proof before signing', async () => {
  testNetwork = 'mainnet';
  const setup = await start();
  expect(setup.consent!.network).toBe('mainnet');
  await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit();
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
  const requested = await aborts.request(uid, setup.id, 'mainnet-abort-original-key', () => clock), authority = (await aborts.lease(requested.id))!;
  expect(authority.network).toBe('mainnet');
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
  const good = flatAbortProof(), wrong: SetupAbortFlatObservation = { ...good, snapshot: { ...good.snapshot, network: 'testnet' } };
  await expect(refunds.reserve(authority, wrong, () => clock)).rejects.toThrow();
  const first = (await refunds.reserve(authority, flatAbortProof(), () => clock))!;
  expect(first).toMatchObject({ network: 'mainnet', destination: owner.address.toLowerCase(), amount: '100', setupAbortId: authority.id });
  const current = await aborts.find(uid, authority.id);
  expect((await refunds.reserve(current, flatAbortProof(), () => clock))!.id).toBe(first.id);
  const stale = flatAbortProof(); later(5001);
  await expect(refunds.begin(current, first.id, stale, () => clock)).rejects.toThrow();
  expect((await returns.find(uid, first.id)).attemptedAt).toBeNull();
  const [one, two] = await Promise.all([refunds.begin(current, first.id, flatAbortProof(), () => clock), refunds.begin(current, first.id, flatAbortProof(), () => clock)]);
  expect([one, two].filter(Boolean)).toHaveLength(1);
  expect((await db.select().from(copyFundingOperations)).filter(row => row.direction === 'to_main')).toHaveLength(1);
  expect((await db.select().from(copyFundingOperations)).filter(row => row.direction === 'to_account')).toHaveLength(1);
});

it('mainnet advertises abort only when execution and the policy signer are available', () => {
  testNetwork = 'mainnet';
  const signer = { available: true };
  const args = [config(), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, signer, {}, new BackgroundJobs()] as unknown as ConstructorParameters<typeof CopyLiveSetupAbortService>;
  expect(new CopyLiveSetupAbortService(...args).available).toBe(true);
  signer.available = false;
  expect(new CopyLiveSetupAbortService(...args).available).toBe(false);
});

describe('a setup awaiting its credit backs off (an unreachable explorer, 2026-10-12: revision 12716 in 14 h)', () => {
  const current = async () => (await db.select().from(copyLiveSetups))[0]!;
  async function awaiting() {
    // The confirm drives the setup at once: its first wait.
    const setup = await start();
    expect(await service.confirm(uid, setup.id, await sign(setup.consent!))).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit' });
    return setup;
  }
  it('waits 3 s, doubling each pass up to 60 s; never an attempt; one revision for the issue and none for each wait', async () => {
    await awaiting();
    const first = await current();
    expect(first).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit', attempts: 0, lastWait: { step: 'funding_submitted', reason: 'awaiting_credit', retryMs: 3_000, waits: 1 } });
    expect(first.nextAttemptAt!.getTime()).toBe(clock + 3_000);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      later(60_000); expect(await service.tick()).toBe(1);
      const row = await current();
      waits.push(row.nextAttemptAt!.getTime() - clock);
      expect(row).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit', revision: first.revision, attempts: 0, updatedAt: first.updatedAt, lastWait: { waits: i + 2 } });
    }
    expect(waits).toEqual([6_000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000]);
  });
  it('is not driven before its wait is due; the credit resets it: the setup moves on and waits no more', async () => {
    const setup = await awaiting();
    later(3_000); await service.tick(); later(6_000); await service.tick();
    expect((await current()).nextAttemptAt!.getTime()).toBe(clock + 12_000);
    later(11_000); expect(await service.tick()).toBe(0);
    await credit(); later(1_000); expect(await service.tick()).toBe(1);
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'running', issue: null });
    expect(await current()).toMatchObject({ attempts: 0, nextAttemptAt: null });
  });
  it('survives a restart: a new service instance keeps the wait the row holds', async () => {
    await awaiting();
    for (const ms of [3_000, 6_000, 12_000]) { later(ms); await service.tick(); }
    const before = await current();
    expect(before.nextAttemptAt!.getTime()).toBe(clock + 24_000);
    fakes = build();
    later(10_000); expect(await service.tick()).toBe(0);
    expect(await current()).toMatchObject({ revision: before.revision, nextAttemptAt: before.nextAttemptAt, lastWait: before.lastWait });
    later(14_000); expect(await service.tick()).toBe(1);
    expect(await current()).toMatchObject({ revision: before.revision, attempts: 0, lastWait: { waits: 5, retryMs: 48_000 } });
  });
  it('logs ALERT funding awaiting_credit past 10 minutes since its confirm, at most once per 10 minutes, across a restart', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const alerts = () => errors.mock.calls.map(([message]) => String(message)).filter(message => message.startsWith('ALERT funding awaiting_credit '));
    const setup = await awaiting(), confirmedAt = clock;
    for (let minute = 1; minute <= 10; minute++) { later(60_000); await service.tick(); }
    expect(alerts()).toEqual([]);
    later(60_000); await service.tick();
    expect(alerts()).toHaveLength(1);
    expect(JSON.parse(alerts()[0]!.slice('ALERT funding awaiting_credit '.length))).toMatchObject({ setupId: setup.id, fundingOperationId: setup.consent!.fundingOperationId,
      awaitingCreditSince: new Date(confirmedAt).toISOString(), minutes: 11, explorerReachable: true, explorerFailingSince: null });
    expect((await current()).lastWait).toMatchObject({ alertedAt: new Date(clock).toISOString() });
    // A restart keeps the rate: the next one ten minutes after the first.
    fakes = build();
    for (let minute = 1; minute <= 9; minute++) { later(60_000); await service.tick(); }
    expect(alerts()).toHaveLength(1);
    later(60_000); await service.tick();
    expect(alerts()).toHaveLength(2);
    expect(await current()).toMatchObject({ stage: 'funding_submitted', attempts: 0 });
  });
});

describe('cancel and refund a confirmed setup awaiting its credit (funding_submitted)', () => {
  const ok = { status: 'ok', response: { type: 'default' } };
  const EXPIRY = 2 * 86_400_000 + 3_600_000;
  /** A flat account holding `balance` (the account's own state, info API). */
  function proofOf(balance: string): SetupAbortFlatObservation {
    const proof = flatAbortProof();
    Object.assign(proof.snapshot, { withdrawable: balance, perpEquity: balance });
    Object.assign(proof.snapshot.dexes[0]!, { equity: balance, rawUsd: balance, withdrawable: balance, crossEquity: balance });
    return proof;
  }
  /** The setup service with the real abort worker behind its cancel; the
   * worker's exchange and observer read `world.balance` (the copy account). */
  function cancelWorld(funding: object = fakes.funding) {
    const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
    const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(mandates));
    const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
    const world = { balance: '0' };
    const observer = { observeSetupAbortFlat: vi.fn(async () => proofOf(world.balance)) };
    const exchange = { acquire: vi.fn(async () => undefined), withdrawable: vi.fn(async () => world.balance),
      send: vi.fn(async (_op: unknown, _sig: string, fresh: () => void, dispatched: () => void) => { fresh(); dispatched(); world.balance = '0'; return ok; }) };
    const signer = { available: true, sign: vi.fn(async () => 'test-worker-signature') };
    const worker = new CopyLiveSetupAbortService(config(), aborts, refunds, new CopyLiveSetupRepository(db), new CopyFundingRepository(db),
      funding as never, fakes.agents as never, fakes.modes as never, {} as never, returns, exchange as never, signer as never, observer as never, new BackgroundJobs(), () => clock);
    const setups = new CopyLiveSetupService(config(), new CopyLiveSetupRepository(db), new UnitOfWork(db), mandates, fakes.wallets as never, new CopyWalletRepository(db),
      fakes.agents as never, fakes.modes as never, fakes.funding as never, new CopyFundingRepository(db), {} as never, {} as never, { available: true, sign: workerSign } as never,
      () => clock, fakes.jobs, worker, fakes.leaderActivity);
    const abortOf = async (setupId: string) => (await db.select().from(copyLiveSetupAborts).where(eq(copyLiveSetupAborts.setupId, setupId)))[0]!;
    const pass = async (setupId: string) => { const abort = await abortOf(setupId); await worker.process(abort.id); return abortOf(setupId); };
    return { world, setups, worker, exchange, observer, signer, aborts, refunds, returns, abortOf, pass };
  }
  async function awaitingCredit() {
    const setup = await start();
    expect(await service.confirm(uid, setup.id, await sign(setup.consent!))).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit' });
    return setup;
  }
  const refundsOf = async () => (await db.select().from(copyFundingOperations)).filter(row => row.direction === 'to_main');
  const depositOf = async () => (await db.select().from(copyFundingOperations)).find(row => row.direction === 'to_account')!;
  /** The funding monitor confirms every accepted refund's credit. */
  const creditRefunds = async () => {
    for (const row of await refundsOf()) if (row.status === 'accepted') await db.update(copyFundingOperations).set({ status: 'credited',
      transactionHash: `0x${createHash('sha256').update(row.id).digest('hex')}`, creditedAmount: row.amount, fee: '0' }).where(eq(copyFundingOperations.id, row.id));
  };
  const alerts = (errors: { mock: { calls: unknown[][] } }, kind: string) => errors.mock.calls.filter(([line]) => String(line).startsWith(`ALERT setup_abort ${kind} `)).length;
  /** No generation, no activation and nothing the driver signs after the cancel. */
  async function neverStarted(setupId: string) {
    await credit(); later(120_000); await service.tick();
    expect(await db.select().from(copyLiveMandates)).toHaveLength(0);
    expect(await db.select().from(copyLiveActivations)).toHaveLength(0);
    expect(workerSign).not.toHaveBeenCalled(); expect(fakes.modes.submit).not.toHaveBeenCalled(); expect(fakes.agents.submit).not.toHaveBeenCalled();
    expect((await service.get(uid, setupId)).stage).not.toBe('running');
  }

  it('returns everything the account holds to the main wallet and never creates a mandate', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    const cancelled = await w.setups.cancel(uid, setup.id);
    expect(cancelled).toMatchObject({ id: setup.id, stage: 'funding_submitted', abortRequested: true });
    // Idempotent: a second press is the same cancel.
    expect(await w.setups.cancel(uid, setup.id)).toMatchObject({ abortRequested: true });
    expect(await db.select().from(copyLiveSetupAborts)).toHaveLength(1);
    // The deposit arrived (the account's balance), its credit not yet confirmed.
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
    expect(await refundsOf()).toMatchObject([{ amount: '100', status: 'accepted', address: accountAddress, destination: owner.address.toLowerCase() }]);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled', abortRequested: true });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'stopped' });
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'refunding', issue: 'setup_abort_refund_pending', refund: { amount: '100', status: 'accepted' } });
    await neverStarted(setup.id);
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
  });

  it('a stale or unavailable read waits (never blocked) and backs off per row from 3 s doubling to 60 s, without new revisions; the refund then goes out', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    // The flat proof's read fails with no code of its own (a stale or timed-out read).
    w.observer.observeSetupAbortFlat.mockRejectedValue(new Error('info read timed out'));
    const first = await w.pass(setup.id);
    expect(first).toMatchObject({ state: 'proving', issue: 'setup_abort_evidence_unavailable', backoff: { failures: 1, nextAt: clock + 3_000 } });
    expect(first.nextAttemptAt!.getTime()).toBe(clock + 3_000);
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'reconciling', issue: 'setup_abort_evidence_unavailable', refund: null });
    for (const [failures, delay] of [[2, 6_000], [3, 12_000], [4, 24_000], [5, 48_000], [6, 60_000], [7, 60_000]] as const) {
      clock = (await w.abortOf(setup.id)).backoff!.nextAt;
      // The same wait again: bookkeeping only, no new revision.
      expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_evidence_unavailable', revision: first.revision,
        backoff: { failures, nextAt: clock + delay }, nextAttemptAt: new Date(clock + delay) });
    }
    expect(w.exchange.send).not.toHaveBeenCalled();
    // The read answers again: the refund leaves, the wait ends.
    w.observer.observeSetupAbortFlat.mockImplementation(async () => proofOf(w.world.balance));
    later(60_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending', backoff: null });
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled' });
  });

  it('a Hyperliquid weight wait or the worker signer not up waits too; a permanent failure (a binding that no longer matches) still blocks and ends the wait', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    // The shared per-IP meter: its own later time (when it said), not 3 s.
    w.exchange.acquire.mockRejectedValueOnce(new HyperliquidBudgetWait(20_000, 'shared_capacity'));
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'hyperliquid_busy', backoff: { failures: 1, nextAt: clock + 20_000 } });
    // The worker's signer not available: a wait, not "needs action".
    w.signer.available = false; later(65_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_unavailable', backoff: { failures: 2, nextAt: clock + 6_000 } });
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'reconciling', issue: 'setup_abort_unavailable' });
    w.signer.available = true; later(6_000);
    // The setup no longer matches what the abort was admitted on: permanent.
    await db.update(copyLiveSetups).set({ intentDigest: 'f'.repeat(64) }).where(eq(copyLiveSetups.id, setup.id));
    expect(await w.pass(setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_binding_unknown', backoff: null });
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_binding_unknown' });
    expect(w.exchange.send).not.toHaveBeenCalled();
  });

  it('money landing after the refund was credited is returned again (a follow-up, abort:<id>:1) with an ALERT, and the cancel completes', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning' });
    await creditRefunds();
    // 5 USDC lands in the copy account after the refund left.
    w.world.balance = '5'; later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    const abort = await w.abortOf(setup.id), refunds = (await refundsOf()).sort((a, b) => a.nonce - b.nonce);
    expect(refunds).toMatchObject([{ idempotencyKey: `abort:${abort.id}`, amount: '100', status: 'credited' },
      { idempotencyKey: `abort:${abort.id}:1`, amount: '5', status: 'accepted', setupAbortId: abort.id, address: accountAddress, destination: owner.address.toLowerCase() }]);
    expect(abort.returnOperationId).toBe(refunds[1]!.id);
    expect(alerts(errors, 'residual_return')).toBe(1);
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled' });
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'refunding', refund: { amount: '5', status: 'accepted' } });
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it(`follow-ups are capped (SETUP_ABORT_RESIDUAL_RETURNS): past them the abort blocks as the owner's (setup_abort_residual_balance) with a rate-limited ALERT`, async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning' });
    for (let n = 1; n <= SETUP_ABORT_RESIDUAL_RETURNS; n++) {
      await creditRefunds(); w.world.balance = '5'; later(30_000);
      expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
      expect(w.exchange.send).toHaveBeenCalledTimes(n + 1);
    }
    await creditRefunds(); w.world.balance = '5'; later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_residual_balance' });
    expect(classify(new Error('setup_abort_residual_balance')).class).toBe('needs_owner');
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_residual_balance' });
    const abort = await w.abortOf(setup.id);
    expect((await refundsOf()).map(row => row.idempotencyKey).sort()).toEqual([`abort:${abort.id}`, `abort:${abort.id}:1`, `abort:${abort.id}:2`, `abort:${abort.id}:3`]);
    expect(w.exchange.send).toHaveBeenCalledTimes(SETUP_ABORT_RESIDUAL_RETURNS + 1);
    expect(alerts(errors, 'residual_cap')).toBe(1);
    // Still blocked on the next pass; the ALERT is not repeated until its interval passed.
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_residual_balance' });
    expect(alerts(errors, 'residual_cap')).toBe(1);
    later(ALERT_EVERY_MS);
    await w.pass(setup.id);
    expect(alerts(errors, 'residual_cap')).toBe(2);
    expect(w.exchange.send).toHaveBeenCalledTimes(SETUP_ABORT_RESIDUAL_RETURNS + 1);
    errors.mockRestore();
  });

  it('a residual is returned once under concurrent drivers: one lease, one follow-up, one send', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning' });
    await creditRefunds(); w.world.balance = '5'; later(30_000);
    // Two reservations racing under one lease (the user lock): the same follow-up.
    const abort = await w.abortOf(setup.id), authority = (await w.aborts.lease(abort.id))!;
    const [first, second] = await Promise.all([w.refunds.reserve(authority, proofOf('5'), () => clock), w.refunds.reserve(authority, proofOf('5'), () => clock)]);
    expect(first!.id).toBe(second!.id);
    expect(first).toMatchObject({ idempotencyKey: `abort:${abort.id}:1`, status: 'prepared', amount: '5' });
    await w.aborts.release(authority);
    // Two worker passes at once (two replicas): one lease sends it, once.
    await Promise.all([w.pass(setup.id), w.pass(setup.id)]);
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    expect(await refundsOf()).toHaveLength(2);
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('with the explorer unreachable, money left after an accepted (not yet credited) refund is returned by a follow-up and the cancel completes', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), deposit = await depositOf(), main = owner.address.toLowerCase();
    // The real confirmation: the info API answers (each transfer is in its
    // ledger), every txDetails read fails.
    const unreachable = vi.fn(async () => { throw new LiveBoundaryError('funding_explorer_unreachable'); });
    const ledger: Record<string, Array<{ hash: string; time: number; delta: Record<string, unknown> }>> = {
      [accountAddress]: [{ hash: `0x${'a1'.repeat(32)}`, time: deposit.nonce + 100, delta: { type: 'internalTransfer', user: main, destination: accountAddress, usdc: '100', fee: '0' } }], [main]: [] };
    const info = { userNonFundingLedgerUpdates: vi.fn(async (user: string) => ledger[user] ?? []) };
    const real = new CopyFundingService(testConfig(), new CopyFundingRepository(db), { overview: vi.fn(async () => ({})) } as never, { txDetails: unreachable } as never, info as never);
    const w = cancelWorld(real);
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    // 5 USDC lands after the refund left; the refund's credit cannot be confirmed.
    const [refund] = await refundsOf();
    ledger[main] = [{ hash: `0x${'b2'.repeat(32)}`, time: refund!.nonce + 100, delta: { type: 'internalTransfer', user: accountAddress, destination: main, usdc: '100', fee: '0' } }];
    unreachable.mockClear();
    w.world.balance = '5'; later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    expect(unreachable).toHaveBeenCalled();
    const abort = await w.abortOf(setup.id), refunds = (await refundsOf()).sort((a, b) => a.nonce - b.nonce);
    // The follow-up is for what the fresh proof shows (the 100's debit already in it): 5, never 105.
    expect(refunds).toMatchObject([{ idempotencyKey: `abort:${abort.id}`, amount: '100', status: 'accepted' },
      { idempotencyKey: `abort:${abort.id}:1`, amount: '5', status: 'accepted' }]);
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.some(([line]) => String(line).startsWith('ALERT setup_abort residual_return ') && String(line).includes('"previousStatus":"accepted"'))).toBe(true);
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled' });
    expect((await refundsOf()).map(row => row.status)).toEqual(['accepted', 'accepted']);
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('a refund whose outcome is unknown (or a proof read before its acceptance) holds the follow-up; once accepted and seen debited, the residual is returned', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    // The POST's answer is lost: the refund may or may not have executed.
    w.exchange.send.mockImplementationOnce(async (_op: unknown, _sig: string, fresh: () => void, dispatched: () => void) => { fresh(); dispatched(); w.world.balance = '0'; return undefined as never; });
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    const [original] = await refundsOf();
    expect(original).toMatchObject({ status: 'unknown' });
    w.world.balance = '5';
    for (let i = 0; i < 3; i++) {
      later(30_000);
      expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending', returnOperationId: original!.id });
    }
    // The reservation itself refuses to stack a follow-up on an unknown refund.
    let authority = (await w.aborts.lease((await w.abortOf(setup.id)).id))!;
    expect(await w.refunds.reserve(authority, proofOf('5'), () => clock)).toMatchObject({ id: original!.id, status: 'unknown' });
    await w.aborts.release(authority);
    expect(await refundsOf()).toHaveLength(1);
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
    // Its receipt arrives: accepted. A proof read before that is not taken as its debit.
    const acceptedAt = new Date(clock + 60_000);
    await db.update(copyFundingOperations).set({ status: 'accepted', evidenceHash: 'e'.repeat(64), updatedAt: acceptedAt }).where(eq(copyFundingOperations.id, original!.id));
    authority = (await w.aborts.lease((await w.abortOf(setup.id)).id))!;
    expect(await w.refunds.reserve(authority, proofOf('5'), () => clock)).toMatchObject({ id: original!.id, status: 'accepted' });
    await w.aborts.release(authority);
    expect(await refundsOf()).toHaveLength(1);
    // A proof read after it: the follow-up goes out for the 5.
    later(90_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    const abort = await w.abortOf(setup.id);
    expect((await refundsOf()).sort((a, b) => a.nonce - b.nonce)).toMatchObject([{ id: original!.id, status: 'accepted' }, { idempotencyKey: `abort:${abort.id}:1`, amount: '5', status: 'accepted' }]);
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    errors.mockRestore();
  });

  it('a residual after an accepted (uncredited) refund is returned once under concurrent drivers: one follow-up, one send', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning' });
    expect(await refundsOf()).toMatchObject([{ status: 'accepted' }]);
    w.world.balance = '5'; later(30_000);
    // Two reservations racing under one lease (the user lock): the same follow-up.
    const abort = await w.abortOf(setup.id), authority = (await w.aborts.lease(abort.id))!;
    const [first, second] = await Promise.all([w.refunds.reserve(authority, proofOf('5'), () => clock), w.refunds.reserve(authority, proofOf('5'), () => clock)]);
    expect(first!.id).toBe(second!.id);
    expect(first).toMatchObject({ idempotencyKey: `abort:${abort.id}:1`, status: 'prepared', amount: '5' });
    await w.aborts.release(authority);
    // Two worker passes at once (two replicas): one lease sends it, once.
    await Promise.all([w.pass(setup.id), w.pass(setup.id)]);
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    expect(await refundsOf()).toHaveLength(2);
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(w.exchange.send).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  /** The copy account holding margin (a position): never proven flat. */
  const notFlatOf = (balance: string) => { const proof = proofOf(balance); Object.assign(proof.snapshot, { totalMarginUsed: '1' }); return proof; };

  it(`an account not flat waits up to SETUP_ABORT_NOT_FLAT_ESCALATE_MS (a failed read in between does not reset it); past it the abort blocks as the owner's with a rate-limited ALERT`, async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    w.observer.observeSetupAbortFlat.mockImplementation(async () => notFlatOf(w.world.balance));
    const since = clock;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { failures: 1, notFlatSince: since } });
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'reconciling', issue: 'setup_abort_proof_not_flat' });
    for (const minutes of [1, 10, 20]) {
      clock = since + minutes * 60_000;
      expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { notFlatSince: since } });
    }
    // A read that failed proves nothing either way: the clock goes on.
    w.observer.observeSetupAbortFlat.mockRejectedValueOnce(new Error('info read timed out'));
    clock = since + 25 * 60_000;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_evidence_unavailable', backoff: { notFlatSince: since } });
    clock = since + SETUP_ABORT_NOT_FLAT_ESCALATE_MS;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { notFlatSince: since } });
    expect(alerts(errors, 'not_flat')).toBe(0);
    // More than 30 minutes on the same abort: the owner's.
    clock = since + SETUP_ABORT_NOT_FLAT_ESCALATE_MS + 1;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_not_flat_persistent', backoff: { notFlatSince: since } });
    expect(classify(new Error('setup_abort_not_flat_persistent')).class).toBe('needs_owner');
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_not_flat_persistent' });
    expect(alerts(errors, 'not_flat')).toBe(1);
    // Still not flat: still blocked, the ALERT not repeated within its interval.
    later(5 * 60_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_not_flat_persistent' });
    expect(alerts(errors, 'not_flat')).toBe(1);
    expect(w.exchange.send).not.toHaveBeenCalled();
    // The owner closes it: a flat proof, the refund leaves, the cancel completes.
    w.observer.observeSetupAbortFlat.mockImplementation(async () => proofOf(w.world.balance));
    later(5 * 60_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending', backoff: null });
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('a flat proof while the account was not flat starts its clock over', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    w.observer.observeSetupAbortFlat.mockImplementation(async () => notFlatOf(w.world.balance));
    const since = clock;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { notFlatSince: since } });
    clock = since + 20 * 60_000;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { notFlatSince: since } });
    // Flat for one pass (the refund then waits for the worker's signer).
    w.observer.observeSetupAbortFlat.mockImplementation(async () => proofOf(w.world.balance));
    w.signer.available = false; clock = since + 21 * 60_000;
    const flatPass = await w.pass(setup.id);
    expect(flatPass).toMatchObject({ state: 'proving', issue: 'setup_abort_unavailable' });
    expect(flatPass.backoff).not.toHaveProperty('notFlatSince');
    // Not flat again: a new clock, from now.
    w.observer.observeSetupAbortFlat.mockImplementation(async () => notFlatOf(w.world.balance));
    w.signer.available = true; clock = since + 22 * 60_000;
    const restarted = clock;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { notFlatSince: restarted } });
    // 40 minutes since the first, 18 since the flat proof: still a wait.
    clock = since + 40 * 60_000;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'proving', issue: 'setup_abort_proof_not_flat', backoff: { notFlatSince: restarted } });
    clock = restarted + SETUP_ABORT_NOT_FLAT_ESCALATE_MS + 1;
    expect(await w.pass(setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_not_flat_persistent' });
    expect(alerts(errors, 'not_flat')).toBe(1);
    expect(w.exchange.send).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it(`a blocked abort (the owner's) is looked at again only every SETUP_ABORT_BLOCKED_RECHECK_MS, without a new revision; a change still moves it on`, async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning' });
    for (let n = 0; n <= SETUP_ABORT_RESIDUAL_RETURNS; n++) { await creditRefunds(); w.world.balance = '5'; later(30_000); await w.pass(setup.id); }
    const blocked = await w.abortOf(setup.id);
    expect(blocked).toMatchObject({ state: 'blocked', issue: 'setup_abort_residual_balance' });
    // Not due again for five minutes (not 30 s): the worker's tick leaves it.
    expect(blocked.nextAttemptAt!.getTime()).toBe(clock + SETUP_ABORT_BLOCKED_RECHECK_MS);
    expect((await w.aborts.open()).map(row => row.id)).not.toContain(blocked.id);
    expect(await w.worker.tick()).toBe(0);
    // Looked at again after them: the same block, bookkeeping only.
    for (let i = 0; i < 3; i++) {
      later(SETUP_ABORT_BLOCKED_RECHECK_MS);
      const again = await w.pass(setup.id);
      expect(again).toMatchObject({ state: 'blocked', issue: 'setup_abort_residual_balance', revision: blocked.revision, updatedAt: blocked.updatedAt });
      expect(again.nextAttemptAt!.getTime()).toBe(clock + SETUP_ABORT_BLOCKED_RECHECK_MS);
    }
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'blocked', issue: 'setup_abort_residual_balance', updatedAt: blocked.updatedAt.toISOString() });
    // The owner moved the money out: the next look completes the cancel.
    w.world.balance = '0'; later(SETUP_ABORT_BLOCKED_RECHECK_MS);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled' });
    expect(w.exchange.send).toHaveBeenCalledTimes(SETUP_ABORT_RESIDUAL_RETURNS + 1);
    errors.mockRestore();
  });

  it('races the setup driver: a driver mid-step when the cancel commits cannot move the setup on', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    await credit(); later(120_000);
    const entered = deferred<void>(), release = deferred<void>();
    const find = CopyFundingRepository.prototype.find;
    const spy = vi.spyOn(CopyFundingRepository.prototype, 'find').mockImplementationOnce(async function (this: CopyFundingRepository, ...args) {
      const row = await find.apply(this, args); entered.resolve(); await release.promise; return row;
    });
    const driving = service.tick(); await entered.promise;
    await w.setups.cancel(uid, setup.id);
    release.resolve(); await driving; spy.mockRestore();
    expect((await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, setup.id)))[0]!.stage).toBe('funding_submitted');
    await neverStarted(setup.id);
  });

  it('races the setup driver: a driver that moved past funding first wins; the cancel waiting for the lock is refused setup_past_funding', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    await credit(); later(120_000);
    const entered = deferred<void>(), release = deferred<void>();
    const original = CopyLiveMandateRepository.prototype.lock;
    const spy = vi.spyOn(CopyLiveMandateRepository.prototype, 'lock').mockImplementationOnce(async function (this: CopyLiveMandateRepository, ...args: Parameters<typeof original>) {
      entered.resolve(); await release.promise; return original.call(this, ...args);
    });
    const cancelling = w.setups.cancel(uid, setup.id).catch(error => error);
    await entered.promise;
    await service.tick();
    release.resolve(); const result = await cancelling; spy.mockRestore();
    expect(result).toMatchObject({ status: 409, response: { code: 'setup_past_funding' } });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'running', abortRequested: false });
    expect(await db.select().from(copyLiveSetupAborts)).toHaveLength(0);
  });

  it('is refused once the setup moved past funding (no mandate yet, or the mandate exists): the copy is stopped instead', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    await db.update(copyLiveSetups).set({ stage: 'mode_set' }).where(eq(copyLiveSetups.id, setup.id));
    await expect(w.setups.cancel(uid, setup.id)).rejects.toMatchObject({ status: 409, response: { code: 'setup_past_funding' } });
    await db.update(copyLiveSetups).set({ stage: 'funding_submitted' }).where(eq(copyLiveSetups.id, setup.id));
    await credit(); later(120_000); await service.tick();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'running' });
    await expect(w.setups.cancel(uid, setup.id)).rejects.toMatchObject({ status: 409, response: { code: 'setup_past_funding' } });
    // A mandate recorded while the stage still reads funding_submitted is refused too.
    await db.update(copyLiveSetups).set({ stage: 'funding_submitted', mandateId: null }).where(eq(copyLiveSetups.id, setup.id));
    await expect(w.setups.cancel(uid, setup.id)).rejects.toMatchObject({ status: 409, response: { code: 'setup_past_funding' } });
    expect(await db.select().from(copyLiveSetupAborts)).toHaveLength(0);
    expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ state: 'active' });
  });

  it('funds still travelling when cancelled: the refund waits for the balance, then returns all of it', async () => {
    const setup = await awaitingCredit(), w = cancelWorld();
    await w.setups.cancel(uid, setup.id);
    for (let i = 0; i < 3; i++) {
      later(30_000);
      expect(await w.pass(setup.id)).toMatchObject({ state: 'waiting_credit', issue: 'setup_abort_deposit_pending' });
    }
    expect(w.exchange.send).not.toHaveBeenCalled(); expect(await refundsOf()).toHaveLength(0);
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'reconciling', issue: 'setup_abort_deposit_pending', refund: null });
    // The deposit lands: 100 USDC in the copy account.
    w.world.balance = '100'; later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning' });
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
    expect(await refundsOf()).toMatchObject([{ amount: '100', status: 'accepted' }]);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    await neverStarted(setup.id);
  });

  it.each([
    ['proven never executed (the existing not-executed logic: the deposit ends rejected)', 'rejected'],
    ['still unresolved once its nonce expired (it can no longer execute)', 'unknown'],
  ] as const)('a deposit %s ends the abort with nothing to return', async (_case, outcome) => {
    const setup = await awaitingCredit(), w = cancelWorld();
    // Its POST answer was lost: Hyperliquid may or may not have taken it.
    await db.update(copyFundingOperations).set({ status: 'unknown', evidenceHash: null }).where(eq(copyFundingOperations.direction, 'to_account'));
    await w.setups.cancel(uid, setup.id);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'waiting_credit', issue: 'setup_abort_deposit_pending' });
    const deposit = await depositOf();
    if (outcome === 'rejected') {
      // The funding monitor's own pass past the nonce window: a complete
      // ledger read with no transfer at all, so it can never execute.
      const info = { userNonFundingLedgerUpdates: vi.fn(async () => []) };
      const monitor = new CopyFundingService(testConfig(), new CopyFundingRepository(db), { overview: vi.fn(async () => ({})) } as never, { txDetails: vi.fn() } as never, info as never);
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(deposit.nonce + EXPIRY + 1);
      try { await monitor.reconcile(uid, deposit.id); } finally { vi.useRealTimers(); }
      expect((await depositOf()).status).toBe('rejected');
      later(30_000);
    } else {
      // Just before expiry it still waits; once past it, the balance is final.
      clock = deposit.nonce + EXPIRY - 1;
      expect(await w.pass(setup.id)).toMatchObject({ state: 'waiting_credit' });
      clock = deposit.nonce + EXPIRY;
    }
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done', returnOperationId: null });
    expect(w.exchange.send).not.toHaveBeenCalled(); expect(await refundsOf()).toHaveLength(0);
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled' });
    // Nothing returned; a deposit still unresolved shows its confirmation pending (the funding monitor ends it).
    expect(await w.worker.get(uid, setup.id)).toMatchObject(outcome === 'rejected' ? { state: 'completed', refund: null }
      : { state: 'reconciling', issue: 'setup_abort_deposit_pending', refund: null, deposit: { status: 'unknown' } });
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'stopped' });
  });

  it('refunds with the explorer unreachable: the ledger proves the deposit, the refund is sent, and its lagging credit does not hold the cancel', async () => {
    const setup = await awaitingCredit(), deposit = await depositOf(), main = owner.address.toLowerCase();
    // The real confirmation: the info API answers, every txDetails read fails.
    const unreachable = vi.fn(async () => { throw new LiveBoundaryError('funding_explorer_unreachable'); });
    const ledger: Record<string, Array<{ hash: string; time: number; delta: Record<string, unknown> }>> = { [accountAddress]: [], [main]: [] };
    const info = { userNonFundingLedgerUpdates: vi.fn(async (user: string) => ledger[user] ?? []) };
    const real = new CopyFundingService(testConfig(), new CopyFundingRepository(db), { overview: vi.fn(async () => ({})) } as never, { txDetails: unreachable } as never, info as never);
    const w = cancelWorld(real);
    await w.setups.cancel(uid, setup.id);
    // The deposit lands in the copy account's ledger; the balance read fails.
    ledger[accountAddress] = [{ hash: `0x${'a1'.repeat(32)}`, time: deposit.nonce + 100, delta: { type: 'internalTransfer', user: main, destination: accountAddress, usdc: '100', fee: '0' } }];
    w.exchange.withdrawable.mockRejectedValue(new Error('info unavailable'));
    w.world.balance = '100';
    expect(await w.pass(setup.id)).toMatchObject({ state: 'returning', issue: 'setup_abort_refund_pending' });
    expect(unreachable).toHaveBeenCalled();
    expect(await depositOf()).toMatchObject({ status: 'accepted', scanState: { pendingDetails: [{ hash: `0x${'a1'.repeat(32)}` }], explorerFailingSince: expect.any(Number) } });
    const [refund] = await refundsOf();
    expect(refund).toMatchObject({ amount: '100', status: 'accepted' });
    // The refund's own credit needs the explorer too: it stays accepted, the cancel completes.
    ledger[main] = [{ hash: `0x${'b2'.repeat(32)}`, time: refund!.nonce + 100, delta: { type: 'internalTransfer', user: accountAddress, destination: main, usdc: '100', fee: '0' } }];
    later(30_000);
    expect(await w.pass(setup.id)).toMatchObject({ state: 'done' });
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledWith(main, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect((await refundsOf())[0]).toMatchObject({ status: 'accepted' });
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'cancelled' });
    expect(await w.worker.get(uid, setup.id)).toMatchObject({ state: 'refunding', issue: 'setup_abort_refund_pending' });
    expect(w.exchange.send).toHaveBeenCalledTimes(1);
    await neverStarted(setup.id);
  });
});

describe('API_SETUP_DRIVE=worker: the api records, the copy worker drives (design §2.3, Phase 1a-4)', () => {
  const pools: Pool[] = [], clients: PoolClient[] = [];
  const pool = () => { const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); p.on('error', () => undefined); pools.push(p); return p; };
  afterEach(async () => {
    for (const c of clients.splice(0)) c.release(true);
    for (const p of pools.splice(0)) await p.end().catch(() => undefined);
  });
  /** Every `copy_setup_due` notification, as the worker would hear it. */
  async function hear() {
    const client = await pool().connect(), heard: string[] = [];
    clients.push(client);
    client.on('notification', message => { if (message.channel === 'copy_setup_due') heard.push(message.payload!); });
    await client.query('LISTEN copy_setup_due');
    return heard;
  }
  const dueAt = async (id: string) => (await db.select().from(copyLiveSetups).where(eq(copyLiveSetups.id, id)))[0]!.nextAttemptAt;
  const dbNow = async () => new Date((await db.execute<{ now: string }>(sql`select clock_timestamp() as now`)).rows[0]!.now);

  it('confirm records the consent and sends the deposit (browser-signed, still the api\'s), then only marks the setup due and wakes the worker: it never drives', async () => {
    setupDrive = 'worker';
    const drive = vi.spyOn(service, 'drive'), heard = await hear();
    const setup = await start();
    const confirmed = await service.confirm(uid, setup.id, await sign(setup.consent!));
    expect(confirmed).toMatchObject({ stage: 'funding_submitted' });
    expect(fakes.funding.submit).toHaveBeenCalledTimes(1);
    expect(drive).not.toHaveBeenCalled();
    expect(workerSign).not.toHaveBeenCalled();
    const due = await dueAt(setup.id);
    expect(due === null || due.getTime() <= (await dbNow()).getTime()).toBe(true);
    await expect.poll(() => heard).toEqual([setup.id]);
    // The local default still drives inside the request, as before.
    setupDrive = 'local';
    await service.advance(uid, setup.id);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  /** Every call that reaches Hyperliquid (or signs) through the setup's collaborators. */
  const providerCalls = () => [fakes.funding.reconcile, fakes.modes.reconcile, fakes.agents.reconcile, fakes.wallets.reconcile, fakes.leaderActivity.copyActivity, workerSign]
    .reduce((n, mock) => n + mock.mock.calls.length, 0);

  it('advance makes no Hyperliquid call: it marks the setup due now and wakes the worker, whose drive reconciles the deposit (the api did before)', async () => {
    setupDrive = 'worker';
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!));
    // The worker's pass found no credit yet: it looks again later.
    later(5_000); await service.tick();
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit' });
    expect((await dueAt(setup.id))!.getTime()).toBeGreaterThan((await dbNow()).getTime());
    const drive = vi.spyOn(service, 'drive'), heard = await hear();
    await credit();
    vi.clearAllMocks();
    const answered = await service.advance(uid, setup.id);
    expect(answered).toMatchObject({ stage: 'funding_submitted' });
    // Nothing on the api's egress: no deposit reconcile, no step, no signature.
    expect(fakes.funding.reconcile).not.toHaveBeenCalled();
    expect(providerCalls()).toBe(0);
    expect(drive).not.toHaveBeenCalled();
    expect((await dueAt(setup.id))!.getTime()).toBeLessThanOrEqual((await dbNow()).getTime());
    await expect.poll(() => heard).toEqual([setup.id]);
    // The copy worker's wake-up (CopySetupDueListener → driveDue) reconciles the deposit, then drives it to the end.
    await service.driveDue(setup.id);
    expect(fakes.funding.reconcile).toHaveBeenCalledTimes(1);
    expect(fakes.funding.reconcile).toHaveBeenCalledWith(uid, setup.consent!.fundingOperationId);
    expect(await service.get(uid, setup.id)).toMatchObject({ stage: 'running' });
  });

  it('API_SETUP_DRIVE=local keeps the deposit reconcile in advance, as before', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!));
    vi.clearAllMocks();
    await service.advance(uid, setup.id);
    expect(fakes.funding.reconcile).toHaveBeenCalledTimes(1);
  });

  it('the NOTIFY wakes the copy worker, which drives the setup in under a second; a junk payload is ignored and a dropped LISTEN connection comes back', async () => {
    setupDrive = 'worker';
    const workerPool = pool();
    const listener = new CopySetupDueListener(config(), workerPool, service, fakes.jobs);
    await listener.start();
    try {
      // When each NOTIFY was sent, and when the worker began driving.
      const sentAt: number[] = [], wokenAt: number[] = [];
      const notify = CopyLiveSetupRepository.prototype.notifyDue, driveNow = service.driveDue.bind(service);
      const sent = vi.spyOn(CopyLiveSetupRepository.prototype, 'notifyDue').mockImplementation(async function (this: CopyLiveSetupRepository, id: string) {
        await notify.call(this, id); sentAt.push(Date.now());
      });
      const driveDue = vi.spyOn(service, 'driveDue').mockImplementation(async (id: string) => { wokenAt.push(Date.now()); return driveNow(id); });
      const woken = async (calls: number) => {
        await expect.poll(() => driveDue.mock.calls.length, { interval: 10, timeout: 1000 }).toBe(calls);
        return wokenAt[calls - 1]! - sentAt[calls - 1]!;
      };
      const setup = await start();
      const confirmed = await service.confirm(uid, setup.id, await sign(setup.consent!));
      expect(confirmed.stage).toBe('funding_submitted');
      expect(sent).toHaveBeenCalledTimes(1);
      expect(await woken(1)).toBeLessThan(1000);
      expect(driveDue).toHaveBeenCalledWith(setup.id);
      // The worker's drive looked for the credit (none yet) and waits for it.
      await expect.poll(async () => (await service.get(uid, setup.id)).issue, { timeout: 5000 }).toBe('awaiting_credit');
      // The owner presses on once it arrived: the worker drives it to the end.
      await credit();
      await service.advance(uid, setup.id);
      expect(sent).toHaveBeenCalledTimes(2);
      expect(await woken(2)).toBeLessThan(1000);
      // The worker's drive took the credited setup through its account-mode step (signed by the worker).
      await expect.poll(async () => (await service.get(uid, setup.id)).stage, { timeout: 5000 }).toBe('mode_set');
      expect(workerSign).toHaveBeenCalledTimes(1);
      // Junk on the channel drives nothing.
      await db.execute(sql`select pg_notify('copy_setup_due', 'x; drop table users')`);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(driveDue).toHaveBeenCalledTimes(2);
      // The LISTEN connection is cut: it reconnects (backoff 1 s) and hears again.
      await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN copy_setup_due' and datname = current_database()`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await db.execute(sql`select pg_notify('copy_setup_due', ${setup.id})`);
      await expect.poll(() => driveDue.mock.calls.length, { timeout: 3000 }).toBe(3);
    } finally { await listener.onModuleDestroy(); }
  }, 20_000);
});
