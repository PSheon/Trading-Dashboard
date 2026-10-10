import { setTimeout as yieldIo } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS, findHttpContract, liveCopySetupConsentTypedData, liveCopySetupSchema, liveCopySetupAbortSchema, usdSendTypedData, WALLET_NETWORKS, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import { appSettings, copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyFundingOperations, copyLiveActivations, copyLiveMandates, copyLiveSetups,
  copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyWalletAuthorizations, leaders } from '@trading-dashboard/shared/database';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { wire as fundingWire } from '../src/copy/copy-funding.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveSetupRepository } from '../src/copy/copy-live-setup.repository.js';
import { CopyLiveSetupService } from '../src/copy/copy-live-setup.service.js';
import { CopyLiveSetupAbortRepository } from '../src/copy/copy-live-setup-abort.repository.js';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveSetupAbortReturnRepository } from '../src/copy/copy-live-setup-abort-return.repository.js';
import { CopyLiveReturnRepository } from '../src/copy/copy-live-return.repository.js';
import type { SetupAbortFlatObservation } from '../src/copy/live/live-account-observer.js';
import { CopyLiveSetupAbortService } from '../src/copy/copy-live-setup-abort.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { requestContext } from '../src/runtime/request-middleware.js';
import { CopyLiveSetupController } from '../src/copy/copy-live-setup.controller.js';
import { createAuthedApp, stubPrivy } from './auth-test-utils.js';
import { currentRequestSignal, withRequestSignal } from '../src/runtime/request-context.js';
import { HyperliquidBudgetWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import type { AgentConsentIntent } from '../src/copy/copy-agent-consent.js';
import type { AppConfig } from '../src/config/app-config.js';
import { AccountRepository } from '../src/users/account.repository.js';
import { testConfig as baseTestConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, openCopyTrading, truncateAll, type TestDb } from './db-test-utils.js';

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

function config(): AppConfig {
  const base = testConfig();
  return { get value() { return { ...base.value, copy: { mode: 'testnet', workerIntervalMs: 2000, agent: { workerQuorumId: 'worker-quorum', authorizationPrivateKey: 'k', authorizationPublicKey: 'p' },
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
    claim: vi.fn(async (userId: number, id: string) => fundingRows.claim(userId, id)),
    submit: vi.fn(async (userId: number, id: string, signature: string) => {
      const row = await fundingRows.find(userId, id);
      const valid = await verifyTypedData({ ...(usdSendTypedData(WALLET_NETWORKS[testNetwork], row.destination, row.amount, row.nonce) as unknown as TypedDataDefinition), address: row.address as `0x${string}`, signature: signature as `0x${string}` });
      if (!valid) throw new Error('Invalid funding signature');
      await fundingRows.beginSubmit(userId, id);
      return fundingWire(await fundingRows.finish(userId, id, 'accepted', 'e'.repeat(64)));
    }),
    reconcile: vi.fn(async () => undefined),
  };
  service = new CopyLiveSetupService(config(), new CopyLiveSetupRepository(db), new UnitOfWork(db), new CopyLiveMandateRepository(db, testConfig()), wallets as never, walletRows,
    agents as never, modes as never, funding as never, fundingRows, {} as never, {} as never, { available: true, sign: workerSign } as never, () => flags.ticking ? ++clock : clock, jobs);
  return { wallets, agents, modes, funding, jobs };
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
  testNetwork = 'testnet';
  await truncateAll(db); vi.clearAllMocks(); flags.worker = true; flags.attach = true; flags.ticking = false; clock = Date.now();
  mode = { id: 'mode-op', targetState: 'unknown', submissionState: 'prepared', submits: 0 }; modeIntent = null; agentIntent = null; signed = [];
  uid = (await insertUser(db, { privyUserId: 'did:privy:setup-owner', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await openCopyTrading(db);
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }]);
  await db.insert(appSettings).values({ key: 'revenue', value: adminSettingsSchema.shape.revenue.parse({}) });
  await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS }, reason: 'seeded defaults', createdByUserId: uid });
  fakes = build();
});
afterEach(async () => { vi.useRealTimers(); await fakes?.jobs.drain(1000); });
afterAll(closeTestDb);

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
    later(5_000); expect(await service.tick()).toBe(1);
    expect((await service.get(uid, setup.id))).toMatchObject({ stage: 'funding_submitted', issue: 'awaiting_credit' });
    await credit(); later(5_000);
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
    // Before the deadline the deposit still holds everything.
    await expect(service.cancel(uid, setup.id)).rejects.toMatchObject({ status: 409, response: { code: 'funding_pending' } });
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

  it('no step runs sooner than it was told: a busy shared Hyperliquid window is a wait of at least 65 s, not a failure', async () => {
    const setup = await start();
    await service.confirm(uid, setup.id, await sign(setup.consent!)); await credit(); later(5_000);
    fakes.modes.submit.mockRejectedValueOnce(new HyperliquidBudgetWait(20_000, 'shared_capacity'));
    expect(await service.advance(uid, setup.id)).toMatchObject({ stage: 'funded', issue: 'hyperliquid_busy' });
    const [row] = await db.select().from(copyLiveSetups);
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(clock + 65_000); expect(row!.attempts).toBe(0);
    // Asked to drive every 3 s (and the worker's pass): nothing runs until then.
    for (let i = 0; i < 20; i++) { later(3_000); await service.advance(uid, setup.id); await service.tick(); }
    expect(fakes.modes.submit).toHaveBeenCalledTimes(1);
    later(6_000);
    expect((await service.advance(uid, setup.id)).stage).toBe('running');
    expect(fakes.modes.submit).toHaveBeenCalledTimes(2);
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
    await expect(service.cancel(uid, second.id)).rejects.toMatchObject({ status: 409, response: { code: 'funding_pending' } });
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
    await expect(service.cancel(uid, setup.id)).rejects.toMatchObject({ status: 409, response: { code: 'funding_pending' } });
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
  await aborts.request(uid, setup.id, 'abort-before-generation-key', () => clock);
  release.resolve(); await driving; spy.mockRestore();
  expect(await db.select().from(copyLiveMandates)).toHaveLength(0);
  expect((await service.get(uid, setup.id)).stage).not.toBe('running');
});

it('safe abort: reload reads the permanent abort authority and no longer offers the old consent', async () => {
  const setup = await start();
  const mandates = new CopyLiveMandateRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
  const requested = await aborts.request(uid, setup.id, 'abort-refund-stale-proof-key', () => clock), authority = (await aborts.lease(requested.id))!;
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns), proof = flatAbortProof();
  const row = (await refunds.reserve(authority, proof, () => clock))!;
  later(5_001);
  await expect(refunds.begin(await aborts.find(uid, authority.id), row.id, proof, () => clock)).rejects.toMatchObject({ response: { code: 'setup_abort_proof_stale' } });
  expect((await returns.find(uid, row.id)).attemptedAt).toBeNull();
});

it.each(['late-credit', 'prepared-deposit', 'claimed-deposit', 'prepared-return'] as const)('safe abort: worker restart seals original driver and the unattempted ordinary %s before one verified refund', async ordinaryKind => {
  const setup = await start(); await service.confirm(uid, setup.id, await sign(setup.consent!));
  const mandates = new CopyLiveMandateRepository(db, testConfig()), returns = new CopyLiveReturnRepository(db, testConfig());
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
  const refunds = new CopyLiveSetupAbortReturnRepository(db, testConfig(), mandates, returns);
  const observer = { observeSetupAbortFlat: vi.fn(async () => flatAbortProof()) };
  const exchange = { acquire: vi.fn(async () => undefined), send: vi.fn(async (_op: unknown, _sig: string, fresh: () => void, dispatched: () => void) => {
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
  await fundingRows.claim(uid, prepared.consent!.fundingOperationId);
  await fundingRows.beginSubmit(uid, prepared.consent!.fundingOperationId);
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
  const aborts = new CopyLiveSetupAbortRepository(db, testConfig(), mandates, new CopyLiveStopRepository(db, mandates));
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
