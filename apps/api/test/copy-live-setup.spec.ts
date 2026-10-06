import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type TypedDataDefinition } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSettingsSchema, DEFAULT_COPY_RISK_LIMITS, liveCopySetupConsentTypedData, liveCopySetupSchema, usdSendTypedData, WALLET_NETWORKS, type LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';
import { appSettings, copyAgentSetups, copyControls, copyExecutionAccounts, copyExecutionWallets, copyFundingOperations, copyLiveActivations, copyLiveMandates, copyLiveSetups,
  copyLiveStrategyConfigs, copyRiskPolicies, copyStrategies, copyWalletAuthorizations, leaders } from '@trading-dashboard/shared/database';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyFundingRepository } from '../src/copy/copy-funding.repository.js';
import { wire as fundingWire } from '../src/copy/copy-funding.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { CopyLiveSetupRepository } from '../src/copy/copy-live-setup.repository.js';
import { CopyLiveSetupService } from '../src/copy/copy-live-setup.service.js';
import { HyperliquidBudgetWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { CopyWalletRepository } from '../src/copy/copy-wallet.repository.js';
import type { AgentConsentIntent } from '../src/copy/copy-agent-consent.js';
import type { AppConfig } from '../src/config/app-config.js';
import { AccountRepository } from '../src/users/account.repository.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, openCopyTrading, truncateAll, type TestDb } from './db-test-utils.js';

// The setup service and its SQL are real (Postgres); the providers behind the
// wallet, agent, mode and deposit steps are doubles that keep the same rows
// the real services keep, so the generation step runs the real preparation.
const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`), stranger = privateKeyToAccount(`0x${'05'.repeat(32)}`);
// The copy account: a Privy wallet the owner alone owns; the worker signs for it under the owner's policy.
const copyAccount = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const leader = `0x${'44'.repeat(20)}`, accountAddress = copyAccount.address.toLowerCase(), agentAddress = `0x${'33'.repeat(20)}`;
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: 5, copyStartMode: 'delta' as const };
const flags = { worker: true, attach: true, ticking: false };
let db: TestDb, uid: number, clock: number, service: CopyLiveSetupService;
let mode: { id: string; targetState: string; submissionState: string; submits: number };
/** The mode and agent nonces the fakes allocated (as their services keep them). */
let modeIntent: { operationId: string; accountId: string; strategyId: number; network: 'testnet'; accountAddress: string; nonce: number; consentExpiresAt: number } | null;
let agentIntent: AgentConsentIntent | null;
/** What each fake submission's sign callback returned. */
let signed: string[];
const workerSign = vi.fn(async (..._args: unknown[]) => `0x${'cd'.repeat(65)}`);

function config(): AppConfig {
  const base = testConfig();
  return { get value() { return { ...base.value, copy: { mode: 'testnet', workerIntervalMs: 2000, agent: { workerQuorumId: 'worker-quorum', authorizationPrivateKey: 'k', authorizationPublicKey: 'p' },
    live: { network: 'testnet', caps: { maxStrategiesPerUser: 10 }, builderFee: true, testnetSourceIntervalMs: 60_000, maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300 } } } as never; } } as AppConfig;
}
function build() {
  const fundingRows = new CopyFundingRepository(db), walletRows = new CopyWalletRepository(db);
  const wallets = {
    get workerPolicyEnabled() { return flags.worker; },
    prepare: vi.fn(async (userId: number, strategyId: number) => {
      const id = `acct-${strategyId}`, address = strategyId === 1 ? accountAddress : `0x${'66'.repeat(19)}${String(strategyId).padStart(2, '0')}`;
      await db.insert(copyExecutionAccounts).values({ id, userId, strategyId, network: 'testnet', privyUserId: 'did:privy:setup-owner', externalId: `ext-${id}`, state: 'ready',
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
      await db.insert(copyAgentSetups).values({ id, userId, strategyId: account!.strategyId, accountId, network: 'testnet', idempotencyKey: key, validForDays: days, externalId: `agent-ext-${id}`,
        policyAttemptId: `attempt-${id}`, workerQuorumId: 'worker-quorum', policyId: 'agent-policy', policyFingerprint: 'a'.repeat(64), agentWalletId: `agent-wallet-${id}`, agentOwnerQuorumId: 'owner-quorum',
        agentAddress, accountAddress: account!.address!, accountWalletId: account!.privyWalletId!, accountOwnerQuorumId: 'owner-quorum', state: 'ready', liveSetupId, expiresAt: new Date(Date.now() + days * 86_400_000) }).onConflictDoNothing();
      return (await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id)))[0]!;
    }),
    row: vi.fn(async (_userId: number, id: string) => (await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id)))[0]!),
    reconcile: vi.fn(async () => undefined),
    // As the service does: the current nonce while it lasts, else a new one.
    challengeRow: vi.fn(async (_userId: number, id: string) => {
      const [row] = await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id));
      if (!agentIntent || agentIntent.id !== id || agentIntent.consentExpiresAt <= clock) agentIntent = { id, strategyId: row!.strategyId, network: 'testnet', accountAddress, agentAddress,
        policyId: 'agent-policy', workerQuorumId: 'worker-quorum', nonce: clock, expiresAt: row!.expiresAt.getTime(), consentExpiresAt: clock + 300_000 };
      return agentIntent;
    }),
    submit: vi.fn(async (_userId: number, id: string, authority: { kind: string; consentDigest: string; sign: (master: unknown, intent: AgentConsentIntent, fresh: () => void) => Promise<string> }) => {
      const [row] = await db.select().from(copyAgentSetups).where(eq(copyAgentSetups.id, id));
      const now = Date.now();
      signed.push(await authority.sign({ walletId: 'master-wallet', address: accountAddress, ownerQuorumId: 'owner-quorum' }, agentIntent ?? { id, strategyId: row!.strategyId, network: 'testnet', accountAddress, agentAddress,
        policyId: 'agent-policy', workerQuorumId: 'worker-quorum', nonce: clock, expiresAt: row!.expiresAt.getTime(), consentExpiresAt: clock + 300_000 }, () => undefined));
      // As activate does: the grant, then the setup active.
      await db.update(copyAgentSetups).set({ state: 'revoked' }).where(and(eq(copyAgentSetups.accountId, row!.accountId), eq(copyAgentSetups.state, 'active')));
      const walletId = `wallet-${id}`, grantId = `grant-${id}`;
      await db.update(copyExecutionWallets).set({ retiredAt: new Date() }).where(eq(copyExecutionWallets.accountAddress, accountAddress));
      await db.insert(copyExecutionWallets).values({ id: walletId, userId: row!.userId, strategyId: row!.strategyId, network: 'testnet', accountAddress, privyWalletId: row!.agentWalletId!, privyOwnerId: 'owner-quorum', signerAddress: agentAddress });
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
      if (!modeIntent || modeIntent.consentExpiresAt <= clock + minRemainingMs) modeIntent = { operationId: 'mode-op', accountId: 'a', strategyId: 1, network: 'testnet', accountAddress, nonce: clock, consentExpiresAt: clock + 300_000 };
      return modeIntent;
    }),
    submit: vi.fn(async (_userId: number, _id: string, authority: { sign: (master: unknown, intent: unknown, fresh: () => void) => Promise<string> }) => {
      mode.submits++;
      if (!modeIntent || modeIntent.consentExpiresAt <= clock + 60_000) modeIntent = { operationId: 'mode-op', accountId: 'a', strategyId: 1, network: 'testnet', accountAddress, nonce: clock, consentExpiresAt: clock + 300_000 };
      signed.push(await authority.sign({ walletId: 'master-wallet', address: accountAddress, ownerQuorumId: 'owner-quorum' }, modeIntent, () => undefined));
      mode.targetState = 'supported'; mode.submissionState = 'accepted';
      return mode;
    }),
  };
  const funding = {
    reserve: vi.fn(async (userId: number, accountId: string, input: { idempotencyKey: string; amount: string }) => fundingWire(await fundingRows.reserve(userId, accountId, 'testnet', input))),
    claim: vi.fn(async (userId: number, id: string) => fundingRows.claim(userId, id)),
    submit: vi.fn(async (userId: number, id: string, signature: string) => {
      const row = await fundingRows.find(userId, id);
      const valid = await verifyTypedData({ ...(usdSendTypedData(WALLET_NETWORKS.testnet, row.destination, row.amount, row.nonce) as unknown as TypedDataDefinition), address: row.address as `0x${string}`, signature: signature as `0x${string}` });
      if (!valid) throw new Error('Invalid funding signature');
      await fundingRows.beginSubmit(userId, id);
      return fundingWire(await fundingRows.finish(userId, id, 'accepted', 'e'.repeat(64)));
    }),
    reconcile: vi.fn(async () => undefined),
  };
  service = new CopyLiveSetupService(config(), new CopyLiveSetupRepository(db), new UnitOfWork(db), new CopyLiveMandateRepository(db, testConfig()), wallets as never, walletRows,
    agents as never, modes as never, funding as never, fundingRows, {} as never, {} as never, { available: true, sign: workerSign } as never, () => flags.ticking ? ++clock : clock);
  return { wallets, agents, modes, funding };
}
let fakes: ReturnType<typeof build>;
const start = (key = 'setup-start-key-000001', extra: object = {}) => service.start(uid, { idempotencyKey: key, leader, budgetUsd: '100', settings, ...extra });
async function sign(intent: LiveCopySetupIntent, signer = owner) {
  return { consentSignature: await signer.signTypedData(liveCopySetupConsentTypedData(intent) as never),
    fundingSignature: intent.kind === 'start' ? await signer.signTypedData(usdSendTypedData(WALLET_NETWORKS.testnet, intent.accountAddress, intent.fundingAmount, intent.fundingNonce)) : undefined };
}
async function credit() {
  await db.update(copyFundingOperations).set({ status: 'credited', transactionHash: `0x${'f'.repeat(64)}`, creditedAmount: '100', fee: '0', evidenceHash: 'd'.repeat(64) }).where(eq(copyFundingOperations.direction, 'to_account'));
}
const later = (ms: number) => { clock += ms; };
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  await truncateAll(db); vi.clearAllMocks(); flags.worker = true; flags.attach = true; flags.ticking = false; clock = Date.now();
  mode = { id: 'mode-op', targetState: 'unknown', submissionState: 'prepared', submits: 0 }; modeIntent = null; agentIntent = null; signed = [];
  uid = (await insertUser(db, { privyUserId: 'did:privy:setup-owner', embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await openCopyTrading(db);
  await db.insert(copyControls).values([{ scope: 'platform', scopeId: 0 }]);
  await db.insert(appSettings).values({ key: 'revenue', value: adminSettingsSchema.shape.revenue.parse({}) });
  await db.insert(copyRiskPolicies).values({ limits: { ...DEFAULT_COPY_RISK_LIMITS }, reason: 'seeded defaults', createdByUserId: uid });
  fakes = build();
});
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
    expect(modeCall[2]).toEqual({ network: 'testnet', account: accountAddress });
    expect(agentCall[1]).toMatchObject({ primaryType: 'HyperliquidTransaction:ApproveAgent', message: { agentAddress, agentName: `copy${setup.strategyId} valid_until ${setup.consent!.agentValidUntil}` } });
    expect(agentCall[2]).toEqual({ network: 'testnet', agent: { address: agentAddress, name: `copy${setup.strategyId} valid_until ${setup.consent!.agentValidUntil}` } });
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
