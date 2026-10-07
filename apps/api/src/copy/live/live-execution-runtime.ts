import { createPrivateKey, createPublicKey } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { WALLET_NETWORKS, isHyperliquidNetwork, liveSourceNetworks, type HyperliquidNetwork } from '@trading-dashboard/shared/contracts';
import { copyExecutionAccounts, copyLiveMandates, copyLiveExecutions, copyLiveIntentProvenance,
  copyLiveRiskReservations, copyLiveSignalLegs, copyLiveSourceFills, copyAgentSetups,
  copyExecutionWallets, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from '@trading-dashboard/shared/database';
import { AppConfig } from '../../config/app-config.js';
import { HyperliquidGlobalTransport } from '../../hyperliquid/hyperliquid-global-transport.js';
import { RequestBudgeterService } from '../../hyperliquid/request-budgeter.service.js';
import { liveBudget } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { Dec } from '../../common/decimal/dec.js';
import { decodeLiveCopyMandate } from '../copy-live-mandate-evidence.js';
import { PostgresLivePreparation, liveSourceExecutionCloid, type LivePreparationOptions } from './postgres-live-preparation.js';
import { LiveOrderExecutor, type LiveExecutionRecord } from './live-execution.js';
import { address, LiveBoundaryError, WalletAuthorizationService, type ExchangeApprovalEvidence, type ExchangeApprovalVerifier } from './wallet-authorization.js';
import { PostgresLiveRiskScope, type LiveRiskDatabaseSession } from './postgres-live-risk-scope.js';
import { loadLivePreparationAuthority, riskSourceRequire } from './postgres-live-risk-authority.js';
import { HyperliquidAllDexsAccountSource, PerReadAllDexsAccountSource } from './live-account-ws-source.js';
import { HyperliquidLiveAccountObserver } from './live-account-observer.js';
import { HyperliquidLiveMarketResolver, type LiveMarketResolver } from './live-market-resolver.js';
import type { LiveSharedReads } from './live-shared-reads.js';
import { HyperliquidLiveRiskProvider } from './live-risk-provider.js';
import { LiveProviderReadEpoch } from './live-provider-read-epoch.js';
import { PostgresLiveReservations } from './postgres-live-reservations.js';
import { PostgresLiveRiskSource } from './postgres-live-risk-source.js';
import { ScopedWalletAuthorizationSource } from './scoped-wallet-authorizations.js';
import { HyperliquidAgentApprovalVerifier } from './hyperliquid-agent-approval.js';
import { AccountRiskExecutionGate } from './account-risk-execution-gate.js';
import { BoundaryPrivyOrderSigningClient } from './privy-order-client.js';
import { PrivyOrderSigner } from './privy-order-signer.js';
import { HyperliquidLiveTransport } from './hyperliquid-live-transport.js';
import { ScopedLiveExecutionJournal } from './scoped-live-journal.js';
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from './live-order.js';
import { canonicalLiveSourceLegs, decodeLiveSourceFill, liveSourceLegId } from './copy-live-source-evidence.js';
import { decodeLiveExecutionRow } from './postgres-live-journal.js';
import { decodeLiveSourceSizingEnvelope } from './copy-live-source-planner.js';
import { PostgresLiveUnattemptedRecovery } from './postgres-live-unattempted-recovery.js';
import type { LiveSourceReferenceReader } from './live-source-reference.js';
import { captureLiveOrderIdentity, parseLiveIocAcknowledgement } from './live-order-evidence.js';
import { PostgresLiveSettlement } from './postgres-live-settlement.js';
import { LiveLeverageUpdated, LiveLeverageUpdater, LiveLeverageUpdateRequired } from './live-leverage-update.js';

const id = z.string().min(1).max(160).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const requestSchema = z.object({ userId: z.number().int().positive().max(2147483647), accountId: id,
  mandateId: id, sourceFillId: id, leg: z.enum(['open', 'close']), members: z.array(id).min(1).max(63).optional(),
  signalDeadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const bps = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).refine(v => {
  try { return Dec.from(v).gte(0) && Dec.from(v).lte(10000); } catch { return false; }
});
const optionsSchema = z.object({ slippageBps: bps, extraRiskBufferBps: bps,
  restingOrderBuilderFeeCapTenthsBps: z.number().int().min(0).max(100),
  timeoutMs: z.number().int().min(1).max(5000).optional(), maxSourceDeviationBps: bps.optional() }).strict();
/** Exchange timing hooks for latency measurement (B18): when the order POST
 * starts and when its response arrives. They observe; they cannot veto. */
export interface LiveExecutionHooks {
  readonly reference?: LiveSourceReferenceReader;
  readonly onExchange?: (event: { readonly phase: 'request' | 'response'; readonly at: number }) => void;
}
export interface LiveExecutionRequest {
  readonly userId: number;
  readonly accountId: string;
  readonly mandateId: string;
  readonly sourceFillId: string;
  readonly leg: 'open' | 'close';
  /** One merged adjustment: the other same-coin leader legs it carries. */
  readonly members?: readonly string[];
  /** When the leader's signal stops being worth copying (the leg is refused
   * as expired after it): the evidence's budget wait never outlasts it, so a
   * full bucket can't hold the worker's pass longer than the signal lives. */
  readonly signalDeadline?: number;
}
/** An exchange approval observed this recently is reused within one order
 * (prepare, sign and the final pre-POST check each verify it): its own
 * `checkedAt` still bounds it to 5 s everywhere it is checked, and the local
 * grant (revocation, expiry, rotation) is re-read from SQL every time. */
export const APPROVAL_REUSE_MS = 1000;
function reusedApproval(verifier: ExchangeApprovalVerifier, now: () => number): ExchangeApprovalVerifier {
  let last: { key: string; evidence: Promise<ExchangeApprovalEvidence> } | undefined;
  return { verify: async grant => {
    const key = JSON.stringify([grant.network, grant.accountAddress, grant.signerAddress, grant.id, grant.version]);
    if (last?.key === key) {
      const evidence = await last.evidence.catch(() => undefined);
      if (evidence && now() - evidence.checkedAt <= APPROVAL_REUSE_MS) return structuredClone(evidence);
    }
    const evidence = verifier.verify(grant);
    last = { key, evidence };
    return evidence;
  } };
}
/** The exchange boundary's market checks read the order epoch's metadata
 * (same reads, same clock) when its epoch is still fresh, else their own. */
function epochMarkets(resolver: HyperliquidLiveMarketResolver, shared: () => LiveSharedReads | undefined): LiveMarketResolver {
  const reads = () => { const value = shared(); try { void value?.startedAt; return value; } catch { return undefined; } };
  const fallback = async <T>(work: (shared?: LiveSharedReads) => Promise<T>) => {
    const value = reads();
    if (!value) return work();
    try { return await work(value); }
    catch (error) { if (error instanceof LiveBoundaryError && ['live_risk_stale', 'market_evidence_expired'].includes(error.code)) return work(); throw error; }
  };
  return { network: resolver.network, resolve: coin => fallback(value => resolver.resolve(coin, value)), resolveAsset: asset => fallback(value => resolver.resolveAsset(asset, value)) };
}
/** One copy order on the deployment's network (HYPERLIQUID_NETWORK): every
 * read, signature and order of this runtime is on `network`, and it refuses an
 * account or mandate of any other network. */
export class LiveExecutionRuntime {
  private readonly options: Readonly<LivePreparationOptions>;
  constructor(private readonly network: HyperliquidNetwork, private readonly pool: Pool, private readonly config: AppConfig, private readonly global: HyperliquidGlobalTransport,
    private readonly budget: RequestBudgeterService, options: LivePreparationOptions, private readonly now = Date.now,
    private readonly hooks: LiveExecutionHooks = {}) {
    if (!(pool instanceof Pool) || !(config instanceof AppConfig) || !(global instanceof HyperliquidGlobalTransport) ||
      !(budget instanceof RequestBudgeterService) || typeof now !== 'function' || !isHyperliquidNetwork(network)) throw new LiveBoundaryError('live_runtime_dependencies');
    const parsed = optionsSchema.safeParse(structuredClone(options));
    if (!parsed.success) throw new LiveBoundaryError('live_runtime_options');
    this.options = Object.freeze(parsed.data);
  }
  /** Unregistered application capability. IDs route SQL only; every authority,
   * snapshot and permit is produced by concrete components in this invocation.
   * This method does not settle/release attempted reservations or run a worker. */
  async execute(supplied: LiveExecutionRequest): Promise<LiveExecutionRecord> {
    // An open the account's leverage refuses sets the leverage first (in its
    // own journaled, signed exchange action), then prepares once more on a
    // fresh session and epoch. Once only: still above the cap is a refusal.
    try { return await this.attempt(supplied, false); }
    catch (error) { if (error instanceof LiveLeverageUpdated) return this.attempt(supplied, true); throw error; }
  }
  private async attempt(supplied: LiveExecutionRequest, leverageUpdated: boolean): Promise<LiveExecutionRecord> {
    const parsed = requestSchema.safeParse(structuredClone(supplied));
    if (!parsed.success) throw new LiveBoundaryError('live_runtime_request');
    const request = Object.freeze(parsed.data), app = this.config.value;
    if (app.hyperliquid.wallet.network !== this.network) throw new LiveBoundaryError('live_runtime_network');
    if (!app.hyperliquid.egressKey) throw new LiveBoundaryError('hyperliquid_quota_egress_unconfigured');
    // Bootstrap supplies routing coordinates only. This connection is released
    // before the original lock session, including with a one-connection pool.
    const db = drizzle(this.pool);
    const [routing] = await db.select({ account: copyExecutionAccounts, mandate: copyLiveMandates }).from(copyExecutionAccounts)
      .innerJoin(copyLiveMandates, eq(copyLiveMandates.id, request.mandateId))
      .where(and(eq(copyExecutionAccounts.id, request.accountId), eq(copyExecutionAccounts.userId, request.userId)));
    riskSourceRequire(routing && routing.account.network === this.network && routing.account.address && routing.mandate.accountId === request.accountId &&
      routing.mandate.userId === request.userId && routing.mandate.network === this.network && liveSourceNetworks(this.network).includes(routing.mandate.sourceNetwork), 'live_runtime_identity');
    const accountAddress = address(routing.account.address), leaderAddress = address(routing.mandate.leaderAddress);
    const cloid = liveSourceExecutionCloid(request.mandateId, request.sourceFillId, request.leg), key = `${this.network}:${accountAddress}:${cloid}`;
    const scope = new PostgresLiveRiskScope(this.pool, this.now);
    return scope.run({ userId: request.userId, network: this.network, accountAddress,
      source: { network: routing.mandate.sourceNetwork, leaderAddress } }, async (_scope, session) => this.global.runOriginal(session, async () => {
      // Resolve global configuration against the original private context before
      // creating native clients. No unscoped fallback can open a second pool.
      this.global.currentQuota();
      // Weight through reserveLive: a wait that runs out is a
      // HyperliquidBudgetWait (stored as live_budget_wait), never an uncoded
      // TimeoutError (Stage 2026-10-06), and a weight the bucket can never
      // hold fails at once (live_budget_over_capacity). The order's evidence
      // is paid up front and may wait the bucket's refill time, but never past
      // the signal's deadline; the small reads around a clock wait at most 5 s,
      // as before.
      const prepay = liveBudget(this.budget, request.signalDeadline === undefined ? {}
        : { maxWaitMs: Math.max(0, Math.min(this.budget.refillMs(), request.signalDeadline - this.now())) });
      const acquire = liveBudget(this.budget, { maxWaitMs: 5000 });
      // Each account read gets its own socket: the epoch observes every live
      // account of the owner at once (one shared source refused all but one).
      const sockets = new PerReadAllDexsAccountSource(() => new HyperliquidAllDexsAccountSource(this.now, undefined, this.network, this.global));
      const observer = new HyperliquidLiveAccountObserver(this.network, acquire, this.global.fetchInfo, this.now, 5000, sockets);
      const resolver = new HyperliquidLiveMarketResolver(this.network, acquire, this.global.fetchInfo, this.now);
      const provider = new HyperliquidLiveRiskProvider(this.network, acquire, this.global.fetchInfo, this.now);
      const reservations = new PostgresLiveReservations(this.now);
      // One order's evidence reads are shared by the observer, the resolver
      // and the risk providers, and each wave goes out as one meter charge.
      const epoch = new LiveProviderReadEpoch(observer, resolver, provider, this.options, this.now, { acquire: prepay, fetcher: this.global.fetchInfo,
        batch: (bodies, onDispatch) => this.global.fetchInfoBatch(WALLET_NETWORKS[this.network].infoUrl, bodies, { maxWaitMs: 0, onDispatch: () => { onDispatch(); return undefined; } }) });
      try {
        const existing = await this.existing(session, request, key);
        if (existing?.record.unattemptedRelease || existing?.record.state === 'prepared' && existing.reservation) {
          const reservation = existing.reservation, checkedAt = this.now();
          riskSourceRequire(reservation && (existing.record.unattemptedRelease || reservation.state === 'held' &&
            checkedAt > existing.record.expiresAfter && checkedAt > reservation.expiresAt.getTime()),
            'live_runtime_reservation_recovery_required');
          // Only the dedicated recomputable zero-effect certificate can release
          // this old hold. It replays historical authority/carry on the SAME
          // original session and grants no replacement execution authority.
          await new PostgresLiveUnattemptedRecovery(this.now).releaseExpired(session,
            { accountId: request.accountId, key, expectedReservationRevision: reservation.revision });
          await session.scope.assertHeld();
          const released = await new ScopedLiveExecutionJournal(session, key).get(key);
          riskSourceRequire(released?.state === 'rejected' && released.errorCode === 'unattempted_expired' && released.unattemptedRelease,
            'live_runtime_reservation_recovery_required');
          return released;
        }
        const source = new PostgresLiveRiskSource(observer, resolver, provider, reservations, this.options, this.now, epoch);
        const binding = source.bind(session, { accountId: request.accountId, key });
        const authorizations = new WalletAuthorizationService(new ScopedWalletAuthorizationSource(session,
          existing?.record.authorization.id ?? routing.mandate.authorizationId),
          reusedApproval(new HyperliquidAgentApprovalVerifier(this.network, acquire, this.global.fetchInfo, this.now), this.now), this.now);
        const gate = new AccountRiskExecutionGate(binding.proofSource, this.now);
        const signingClient = new BoundaryPrivyOrderSigningClient(this.network, { appId: app.auth.appId, appSecret: app.auth.appSecret }, fetch, this.now);
        const signingAuthorization = async () => {
          session.scope.assertFresh();
          const authority = await session.read(db => loadLivePreparationAuthority(session, db, request, this.now()));
          this.signingConfiguration(authority.consent.workerQuorumId);
          return { authorization_context: { authorization_private_keys: [app.copy.agent!.authorizationPrivateKey] } };
        };
        const signer = new PrivyOrderSigner(signingClient, authorizations, signingAuthorization, gate, this.now);
        const exchange: { raw?: unknown; at?: number } = {};
        const transport = new HyperliquidLiveTransport(this.network, signer, gate, this.timedFetch(exchange), 5000, this.now,
          { marketResolver: epochMarkets(resolver, () => epoch.sharedReads(session)), acquire, globalTransport: this.global });
        const executor = new LiveOrderExecutor(authorizations, new ScopedLiveExecutionJournal(session, key), transport, gate, this.now);
        if (existing && existing.record.state !== 'prepared') {
          // No prepare/hold/current grant admission/sign on historical recovery.
          return await executor.reconcile(key);
        }
        const authority = await session.read(db => loadLivePreparationAuthority(session, db, request, this.now()));
        this.signingConfiguration(authority.consent.workerQuorumId);
        const preparation = new PostgresLivePreparation(observer, resolver, provider, this.options, this.now, epoch, this.hooks.reference);
        let prepared: Awaited<ReturnType<PostgresLivePreparation['prepare']>>;
        try { prepared = await preparation.prepare(session, request); }
        catch (error) {
          if (!(error instanceof LiveLeverageUpdateRequired)) throw error;
          // Set once; still above the cap after an accepted update is permanent.
          if (leverageUpdated) throw new LiveBoundaryError('live_risk_leverage');
          const state = await new LiveLeverageUpdater(this.network, signingClient, authorizations, signingAuthorization, this.global, fetch, this.now)
            .update(session, { accountId: request.accountId, userId: request.userId, strategyId: authority.strategy.id, walletId: authority.wallet.privyWalletId,
              authorizationId: authority.grant.id, accountAddress, coin: error.coin, asset: error.asset, from: error.current, leverage: error.leverage });
          if (state === 'accepted') throw new LiveLeverageUpdated();
          throw new LiveBoundaryError(state === 'rejected' ? 'live_leverage_update_rejected' : 'live_leverage_update_unknown');
        }
        riskSourceRequire(prepared.record.key === key, 'live_runtime_identity');
        const input = await binding.forHold();
        await reservations.hold(session, input);
        await session.scope.assertHeld();
        const result = await executor.execute(prepared.intent);
        // Keep the exchange's own IOC answer as settlement evidence right away:
        // for a partial fill it is the only proof of the filled quantity
        // (orderStatus then reads "canceled"). Losing it only delays settlement.
        if (exchange.raw !== undefined && exchange.at !== undefined && result.market && result.outcome?.exchangeOrderId &&
          (result.state === 'filled' || result.state === 'partial')) {
          try {
            const acknowledgement = parseLiveIocAcknowledgement({ identity: captureLiveOrderIdentity(result, result.market), raw: exchange.raw, checkedAt: exchange.at });
            await new PostgresLiveSettlement(this.now).acknowledge(session, { accountId: request.accountId, key, acknowledgement });
          } catch { /* settlement reads orderStatus and receipts later */ }
        }
        await sockets.close();
        session.scope.assertFresh();
        // The concrete source binds checkedAt to its oldest original sizing,
        // SQL and all-owner/provider frames. A slow ACK/COMMIT cannot refresh
        // that proof. The durable journal survives an uncertain completion.
        const completedAt = this.now(), oldest = input.localSource.checkedAt;
        riskSourceRequire(Number.isSafeInteger(completedAt) && Number.isSafeInteger(oldest) && oldest > 0 &&
          completedAt >= oldest && completedAt - oldest <= 5000, 'live_risk_stale');
        return result;
      } finally {
        // Await actual private transport cleanup while the original session is
        // live. This source is never reused by a successor execution scope.
        provider.close(); await sockets.close();
      }
    }));
  }
  /** The global fetch, reporting the exchange POST's start and answer times
   * and keeping a copy of the exchange's JSON answer. */
  private timedFetch(capture: { raw?: unknown; at?: number }): typeof fetch {
    const report = this.hooks.onExchange;
    const emit = (phase: 'request' | 'response') => { try { report?.({ phase, at: this.now() }); } catch { /* observation only */ } };
    return async (input, init) => {
      const exchange = String(input instanceof Request ? input.url : input).endsWith('/exchange');
      if (exchange) emit('request');
      try {
        const response = await fetch(input, init);
        if (exchange && response.ok) {
          const at = this.now();
          try { capture.raw = await response.clone().json(); capture.at = at; } catch { /* the transport reports the failure */ }
        }
        return response;
      } finally { if (exchange) emit('response'); }
    };
  }
  private signingConfiguration(workerQuorumId: string): void {
    const { auth, copy } = this.config.value;
    riskSourceRequire(auth.appId && auth.appSecret && copy.agent && copy.agent.workerQuorumId === workerQuorumId, 'live_runtime_signing_configuration');
    try {
      const bytes = Buffer.from(copy.agent.authorizationPrivateKey, 'base64');
      const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
      riskSourceRequire(bytes.toString('base64') === copy.agent.authorizationPrivateKey && key.asymmetricKeyType === 'ec' &&
        key.asymmetricKeyDetails?.namedCurve === 'prime256v1' && key.export({ format: 'der', type: 'pkcs8' }).equals(bytes) &&
        createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') === copy.agent.authorizationPublicKey,
        'live_runtime_signing_configuration');
    } catch { throw new LiveBoundaryError('live_runtime_signing_configuration'); }
  }
  /** Historical immutable identity validation deliberately ignores grant expiry,
   * revocation and strategy stop state. It grants only original-key querying. */
  private async existing(session: LiveRiskDatabaseSession, request: LiveExecutionRequest, key: string): Promise<{
    intent: LiveOrderIntent; record: LiveExecutionRecord;
    reservation: Pick<typeof copyLiveRiskReservations.$inferSelect, 'revision' | 'state' | 'expiresAt'> | null;
  } | null> {
    return session.read(async db => {
      const read = async <T>(query: PromiseLike<T>) => { const value = await query; await session.scope.assertHeld(); return value; };
      const [journal] = await read(db.select().from(copyLiveExecutions).where(eq(copyLiveExecutions.key, key)));
      if (!journal) return null;
      riskSourceRequire(Buffer.byteLength(JSON.stringify(journal.record)) <= 16384, 'live_runtime_historical_identity');
      const [row] = await read(db.select({ provenance: copyLiveIntentProvenance, leg: copyLiveSignalLegs, fill: copyLiveSourceFills,
        account: copyExecutionAccounts, mandate: copyLiveMandates, owner: users, setup: copyAgentSetups, wallet: copyExecutionWallets, grant: copyWalletAuthorizations })
        .from(copyLiveIntentProvenance).innerJoin(copyLiveSignalLegs, eq(copyLiveSignalLegs.id, copyLiveIntentProvenance.legId))
        .innerJoin(copyLiveSourceFills, eq(copyLiveSourceFills.id, copyLiveSignalLegs.sourceFillId))
        .innerJoin(copyExecutionAccounts, eq(copyExecutionAccounts.id, request.accountId))
        .innerJoin(copyLiveMandates, eq(copyLiveMandates.id, copyLiveIntentProvenance.mandateId))
        .innerJoin(users, eq(users.id, copyExecutionAccounts.userId))
        .innerJoin(copyAgentSetups, eq(copyAgentSetups.id, copyLiveMandates.setupId))
        .innerJoin(copyExecutionWallets, eq(copyExecutionWallets.id, copyLiveMandates.executionWalletId))
        .innerJoin(copyWalletAuthorizations, eq(copyWalletAuthorizations.id, copyLiveMandates.authorizationId))
        .where(eq(copyLiveIntentProvenance.key, key)));
      riskSourceRequire(row, 'live_runtime_historical_identity');
      const { account: a, mandate: m, setup: s, wallet: w, grant: g, provenance: p, leg: l, owner: o } = row;
      riskSourceRequire(Buffer.byteLength(JSON.stringify(p.intent)) <= 16384 && Buffer.byteLength(JSON.stringify(p.sizingBasis)) <= 2 * 1024 * 1024 &&
        Buffer.byteLength(JSON.stringify(row.fill.raw)) <= 262144, 'live_runtime_historical_identity');
      const consent = decodeLiveCopyMandate(m), fill = decodeLiveSourceFill(row.fill), intent = structuredClone(p.intent) as unknown as LiveOrderIntent;
      const basis = decodeLiveSourceSizingEnvelope(p.sizingBasis).basis;
      const record = structuredClone(decodeLiveExecutionRow(journal)), action = buildOrderAction(intent), fingerprint = intentFingerprint(intent, action);
      // Revocation advances the mutable grant version once; the immutable
      // owner event proves that transition without changing the saved grant.
      // This read-only historical path never authorizes another signature.
      let historicalGrant = g.version === consent.authorizationVersion;
      if (!historicalGrant && g.version === consent.authorizationVersion + 1 && g.revokedAt !== null) {
        const events = await read(db.select().from(copyWalletAuthorizationEvents).where(and(
          eq(copyWalletAuthorizationEvents.authorizationId, g.id), eq(copyWalletAuthorizationEvents.version, g.version))).limit(2));
        const event = events[0], completedAt = this.now(), revokedAt = g.revokedAt.getTime(), eventAt = event?.createdAt.getTime();
        // Agent retirement uses SQL transaction-start time for the event.
        // SQL and app clocks need not order the event and JS revocation time;
        // each must be observed in the past without a guessed skew allowance.
        historicalGrant = events.length === 1 && event!.authorizationId === g.id && event!.version === g.version &&
          event!.userId === a.userId && event!.action === 'revoked' && Number.isSafeInteger(completedAt) && completedAt > 0 &&
          Number.isSafeInteger(revokedAt) && revokedAt >= record.createdAt && revokedAt <= completedAt &&
          Number.isSafeInteger(eventAt) && eventAt! > 0 && eventAt! <= completedAt;
      }
      const [reservation] = await read(db.select().from(copyLiveRiskReservations).where(eq(copyLiveRiskReservations.key, key)).limit(1));
      const checkedAt = this.now();
      // Verification/state changes may advance a master revision without
      // changing its immutable wallet identity. Only the dedicated SQL-only
      // zero-effect cleanup below can use that monotonic historical revision;
      // financial admission and signing still require current exact consent.
      const zeroEffectCleanup = Boolean(record.unattemptedRelease) || record.state === 'prepared' && reservation?.state === 'held' &&
        Number.isSafeInteger(checkedAt) && checkedAt > record.expiresAfter && checkedAt > reservation.expiresAt.getTime();
      const canonical = canonicalLiveSourceLegs(fill).find(leg => leg.leg === request.leg), identity = session.scope.identity;
      riskSourceRequire(a.id === request.accountId && a.userId === request.userId && a.network === this.network && a.address === identity.accountAddress &&
        a.privyUserId === o.privyUserId && a.privyWalletId === s.accountWalletId && a.ownerQuorumId === s.accountOwnerQuorumId &&
        m.id === request.mandateId && consent.accountId === a.id && consent.userId === a.userId && consent.accountAddress === a.address &&
        consent.ownerPrivyUserId === o.privyUserId && consent.ownerAddress === o.embeddedWalletAddress && consent.sourceNetwork === identity.source?.network &&
        consent.leaderAddress === identity.source?.leaderAddress && (consent.accountRevision === a.revision ||
          zeroEffectCleanup && a.revision >= consent.accountRevision) &&
        s.userId === a.userId && s.strategyId === a.strategyId && s.accountId === a.id && s.network === a.network && s.accountAddress === a.address &&
        s.authorizationId === g.id && s.agentWalletId === w.privyWalletId && s.agentAddress === w.signerAddress && s.agentOwnerQuorumId === w.privyOwnerId &&
        s.workerQuorumId === consent.workerQuorumId && s.policyId === consent.policyId && s.policyFingerprint === consent.policyFingerprint &&
        w.userId === a.userId && w.strategyId === a.strategyId && w.network === a.network && w.accountAddress === a.address && w.privyOwnerId === a.ownerQuorumId &&
        consent.agentWalletId === w.privyWalletId && consent.agentAddress === w.signerAddress && g.walletId === w.id && historicalGrant &&
        m.accountId === a.id && m.strategyId === a.strategyId && p.mandateId === m.id && p.mandateRevision >= 2 && p.mandateRevision <= m.revision &&
        basis.mandateId === m.id && basis.mandateRevision === p.mandateRevision && basis.settingsDigest === p.settingsDigest &&
        basis.sourceFillId === fill.id && basis.sourceDigest === fill.sourceDigest && basis.network === a.network && basis.accountAddress === a.address &&
        basis.coin === fill.coin && basis.leg === request.leg && p.settingsDigest === consent.settingsDigest && p.plannerVersion === 1 &&
        fill.id === request.sourceFillId && fill.network === consent.sourceNetwork && fill.leaderAddress === consent.leaderAddress && p.sourceDigest === fill.sourceDigest && canonical &&
        l.id === liveSourceLegId(m.id, fill.id, request.leg) && l.mandateId === m.id && l.executionKey === key && l.leg === request.leg &&
        l.sign === canonical.sign && l.size === canonical.size && l.fraction === canonical.fraction && l.tradeKey === canonical.tradeKey &&
        intent.userId === a.userId && intent.strategyId === a.strategyId && intent.network === a.network && intent.accountAddress === a.address &&
        intent.walletId === w.privyWalletId && intent.authorizationId === g.id && executionKey(intent) === key && record.key === key &&
        journal.userId === a.userId && journal.strategyId === a.strategyId && journal.network === a.network && journal.accountAddress === a.address &&
        record.authorization.userId === a.userId && record.authorization.strategyId === a.strategyId && record.authorization.network === a.network && record.authorization.accountAddress === a.address &&
        record.authorization.id === g.id && record.authorization.version === consent.authorizationVersion && record.authorization.walletId === w.privyWalletId &&
        record.authorization.privyOwnerId === w.privyOwnerId && record.authorization.signerAddress === w.signerAddress &&
        record.authorization.validFrom === g.validFrom.getTime() && record.authorization.expiresAt === g.expiresAt.getTime() && isDeepStrictEqual(record.authorization.scopes, g.scopes) &&
        record.fingerprint === fingerprint && p.fingerprint === fingerprint && isDeepStrictEqual(record.action, action) && isDeepStrictEqual(record.market, intent.market),
        'live_runtime_historical_identity');
      if (reservation) riskSourceRequire(reservation.accountId === a.id && reservation.userId === a.userId && reservation.strategyId === a.strategyId &&
        reservation.network === a.network && reservation.accountAddress === a.address && reservation.fingerprint === fingerprint &&
        reservation.walletId === w.privyWalletId && reservation.authorizationId === g.id && reservation.authorizationVersion === consent.authorizationVersion,
        'live_runtime_historical_identity');
      return { intent, record, reservation: reservation ? { revision: reservation.revision, state: reservation.state, expiresAt: reservation.expiresAt } : null };
    });
  }
}
