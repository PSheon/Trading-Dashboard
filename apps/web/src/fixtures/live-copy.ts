import { agentApprovalTypedData, liveCopyMandateSchema, liveCopyOverviewSchema, liveCopyPortfolioSchema, liveCopySetupSchema, liveCopySetupsSchema, userSetAbstractionTypedData, WALLET_NETWORKS,
  type CopyMasterActionRequest, type LiveCopyPortfolioItem, type LiveCopySetup, type LiveCopySetupIntent, type LiveCopyStrategy } from "@trading-dashboard/shared/contracts";
import type { ZodTypeAny } from "zod";
import { ApiError } from "@/lib/api";
import { FIXTURE_WALLET_ADDRESS, fixtureOwnerSetupFlag, fixtureSignerFlag, fixtureSigners } from "@/lib/fixture-signer";

/**
 * One-click testnet copy in fixture mode, only with the fixture signer
 * (`?signer=fixture`): the setup endpoints answer as the api does, and each
 * read of a confirmed setup moves it one stage on (deposit → credited →
 * account → agent → started), so a browser test sees every stage. Without
 * the flag these routes don't exist (testnet copy off, as by default).
 *
 * With `?setup=owner` the setup is one the owner's browser signs, as on a
 * deployment without the worker policy: at the account and agent steps the
 * setup parks the copy account's next action (`pendingSignature`) and moves
 * on only when /advance brings its digest and a signature, as the api does.
 * With `?setup=fail` a start fails at the account step after its deposit
 * was credited. As the api: a start is a paused copy in the portfolio from
 * the moment it is prepared, a new start for the same trader ends one that
 * ended or never got its consent, and cancel ends one not running a step.
 * The state is kept for the tab (sessionStorage), so a reload finds it.
 */
const liveFixtureEnabled = () => typeof window !== "undefined" && fixtureSignerFlag(window.location.search);

const ACCOUNT = `0x${"2c".repeat(20)}`, AGENT = `0x${"3d".repeat(20)}`, OWNER = FIXTURE_WALLET_ADDRESS.toLowerCase();
const ORDER: LiveCopySetup["stage"][] = ["funding_submitted", "funded", "mode_set", "agent_active", "builder_ready", "running"];
const setups = new Map<string, LiveCopySetup>();
/** The owner-signed steps: the stage that waits for the action, and where it moves once signed. */
const OWNER_STEPS: Partial<Record<LiveCopySetup["stage"], { kind: CopyMasterActionRequest["kind"]; next: LiveCopySetup["stage"] }>> = {
  funded: { kind: "account_mode", next: "mode_set" }, mode_set: { kind: "agent_approval", next: "agent_active" },
};
let digestCounter = 0;
function pendingAction(setup: LiveCopySetup, kind: CopyMasterActionRequest["kind"]): CopyMasterActionRequest {
  const nonce = Date.now(), validUntil = Date.now() + 30 * 86_400_000;
  const typedData = kind === "account_mode" ? userSetAbstractionTypedData(WALLET_NETWORKS.testnet, ACCOUNT, nonce)
    : agentApprovalTypedData({ id: `agent-${setup.strategyId}`, strategyId: setup.strategyId, network: "testnet", accountAddress: ACCOUNT, agentAddress: AGENT, policyId: "fixture-agent-policy",
      workerQuorumId: "fixture-worker", nonce, expiresAt: validUntil, consentExpiresAt: nonce + 300_000 });
  return { kind, account: ACCOUNT, typedData: JSON.parse(JSON.stringify(typedData)), digest: `0x${(++digestCounter).toString(16).padStart(64, "0")}`, expiresAt: nonce + 235_000 };
}
/** A start's idempotency key → its setup (a retried start answers with it). */
const startKeys = new Map<string, string>();
const strategies = new Map<number, { strategy: LiveCopyStrategy; item: LiveCopyPortfolioItem }>();
let nextStrategy = 41;
const setupItems = new Map<number, LiveCopyPortfolioItem>();
function setupItem(setup: LiveCopySetup): LiveCopyPortfolioItem {
  const consent = setup.stage === "awaiting_consent" && setup.consent && setup.consent.consentExpiresAt > Date.now() ? setup.consent : null;
  return { strategyId: setup.strategyId, leaderAddress: setup.leaderAddress, sourceNetwork: setup.sourceNetwork, budgetUsd: setup.budgetUsd, status: "paused", stage: "setup",
    createdAt: setup.createdAt, accountId: setup.accountId, accountAddress: ACCOUNT, mandate: null, stop: null, pendingTransfer: null, lastRefusal: null, automaticReturn: false, sweep: null,
    setup: { id: setup.id, kind: setup.kind, stage: setup.stage, issue: setup.issue, signer: setup.signer, consent }, expiresAt: null, renewalDue: false, oneClick: true };
}
/** The fixture's live state, kept for the tab so a reload finds it. */
const STORE = "orbie:fixtures:live-copy";
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = sessionStorage.getItem(STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as { setups: [string, LiveCopySetup][]; startKeys: [string, string][]; strategies: [number, { strategy: LiveCopyStrategy; item: LiveCopyPortfolioItem }][];
      setupItems: [number, LiveCopyPortfolioItem][]; nextStrategy: number; digestCounter: number; failedLeaders?: string[] };
    for (const [key, value] of saved.setups) setups.set(key, value);
    for (const [key, value] of saved.startKeys) startKeys.set(key, value);
    for (const [key, value] of saved.strategies) strategies.set(key, value);
    for (const [key, value] of saved.setupItems) setupItems.set(key, value);
    nextStrategy = saved.nextStrategy; digestCounter = saved.digestCounter;
    for (const leader of saved.failedLeaders ?? []) failedLeaders.add(leader);
  } catch { /* nothing kept */ }
}
function persist() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ setups: [...setups], startKeys: [...startKeys], strategies: [...strategies], setupItems: [...setupItems], nextStrategy, digestCounter, failedLeaders: [...failedLeaders] }));
  } catch { /* kept for this page only */ }
}
/** `?setup=fail` fails a trader's first start only (重新開始 then finishes). */
const failedLeaders = new Set<string>();
const failFlag = () => { try { return new URLSearchParams(window.location.search).get("setup") === "fail" || sessionStorage.getItem("orbie:fixtures:setup") === "fail"; } catch { return false; } };
/** The deposit as the api reports it once credited. */
function creditedDeposit(setup: LiveCopySetup): NonNullable<LiveCopySetup["funding"]> {
  return { id: setup.consent?.fundingOperationId || uuid(), accountId: setup.accountId ?? `acct-${setup.strategyId}`, strategyId: setup.strategyId, network: "testnet", address: OWNER, destination: ACCOUNT,
    amount: setup.budgetUsd, nonce: Date.now() - 60_000, status: "credited", canCancel: false, transactionHash: `0x${"e".repeat(64)}`, creditedAmount: setup.budgetUsd, fee: "0",
    direction: "to_account", stopId: null, createdAt: setup.createdAt, updatedAt: iso() };
}
const uuid = () => globalThis.crypto.randomUUID();
const iso = (time = Date.now()) => new Date(time).toISOString();

function consent(setup: LiveCopySetup): LiveCopySetupIntent {
  const now = Date.now(), start = setup.kind === "start";
  return { kind: setup.kind, setupId: setup.id, userId: 1, ownerAddress: OWNER, ownerPrivyUserId: "did:privy:fixture", strategyId: setup.strategyId, leaderAddress: setup.leaderAddress,
    sourceNetwork: setup.sourceNetwork, network: "testnet", budgetUsd: setup.budgetUsd, settingsDigest: "a".repeat(64), accountId: `acct-${setup.strategyId}`, accountAddress: ACCOUNT,
    accountAbstraction: "disabled", agentAddress: AGENT, agentPolicyId: "fixture-agent-policy", agentPolicyFingerprint: "b".repeat(64), workerQuorumId: "fixture-worker",
    agentValidUntil: now + 30 * 86_400_000, builderAddress: null, builderMaxFeeTenthsOfBps: 0, sweepDestination: OWNER,
    // `?setup=owner`: a deployment with the automatic return off binds no policy.
    ...(fixtureOwnerSetupFlag(window.location.search) ? { masterPolicyId: "", masterPolicyFingerprint: "" } : { masterPolicyId: "fixture-master-policy", masterPolicyFingerprint: "c".repeat(64) }),
    fundingOperationId: start ? uuid() : "", fundingNonce: start ? now - 1 : 0, fundingAmount: start ? setup.budgetUsd : "0", nonce: now, consentExpiresAt: now + 300_000, setupDeadline: now + 86_400_000 };
}
function finish(setup: LiveCopySetup) {
  const held = strategies.get(setup.strategyId);
  const mandate = { id: `mandate-${setup.id.slice(0, 8)}`, state: "active" as const, revision: 1 };
  if (held) {
    held.item = { ...held.item, budgetUsd: setup.budgetUsd, mandate, setup: null, stage: "active", status: "active" };
    held.strategy = { ...held.strategy, budgetUsd: setup.budgetUsd, settings: setup.settings, version: held.strategy.version + 1, status: "active" };
    return;
  }
  const strategy: LiveCopyStrategy = { id: setup.strategyId, mode: "actual", network: "testnet", sourceNetwork: setup.sourceNetwork, leaderAddress: setup.leaderAddress, budgetUsd: setup.budgetUsd,
    status: "active", version: 1, settings: setup.settings, pauseNewRisk: false, reduceOnly: false, createdAt: setup.createdAt };
  strategies.set(setup.strategyId, { strategy, item: { strategyId: setup.strategyId, leaderAddress: setup.leaderAddress, sourceNetwork: setup.sourceNetwork, budgetUsd: setup.budgetUsd, status: "active",
    stage: "active", createdAt: setup.createdAt, accountId: `acct-${setup.strategyId}`, accountAddress: ACCOUNT, mandate, stop: null, pendingTransfer: null, lastRefusal: null,
    automaticReturn: true, sweep: null, setup: null, expiresAt: iso(Date.now() + 30 * 86_400_000), renewalDue: false, oneClick: true } });
}
function step(setup: LiveCopySetup, signed?: { digest?: unknown; signature?: unknown }): LiveCopySetup {
  const at = ORDER.indexOf(setup.stage);
  if (setup.stage === "consented") return save({ ...setup, stage: "running" });
  const owner = setup.signer === "owner_session" ? OWNER_STEPS[setup.stage] : undefined;
  if (owner) {
    const pending = setup.pendingSignature;
    if (!pending) return save({ ...setup, issue: "awaiting_owner_signature", pendingSignature: pendingAction(setup, owner.kind) });
    if (!signed?.digest) return setup;
    if (signed.digest !== pending.digest) throw new ApiError(409, "The action changed; sign the current one", { code: "owner_signature_stale" });
    if (typeof signed.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signed.signature)) throw new ApiError(403, "The signature is not the copy account's for this action", { code: "owner_signature_invalid" });
    const moved = save({ ...setup, stage: owner.next, issue: null, pendingSignature: null });
    const following = OWNER_STEPS[moved.stage];
    return following ? save({ ...moved, issue: "awaiting_owner_signature", pendingSignature: pendingAction(moved, following.kind) }) : moved;
  }
  if (at < 0 || setup.stage === "running") return setup;
  // `?setup=fail`: the account step is refused after the deposit was credited.
  if (setup.kind === "start" && setup.stage === "funded" && failFlag() && !failedLeaders.has(setup.leaderAddress)) {
    failedLeaders.add(setup.leaderAddress);
    return save({ ...setup, stage: "failed", issue: "setup_account_mode_failed", pendingSignature: null, funding: creditedDeposit(setup) });
  }
  const next = ORDER[at + 1]!;
  return save({ ...setup, stage: next, issue: null, ...(setup.kind === "start" && ORDER.indexOf(next) >= ORDER.indexOf("funded") && !setup.funding ? { funding: creditedDeposit(setup) } : {}) });
}
function save(setup: LiveCopySetup) {
  const next = { ...setup, updatedAt: iso() };
  setups.set(next.id, next);
  if (next.stage === "running") finish(next);
  const held = strategies.get(next.strategyId);
  if (held && next.kind !== "start") held.item = { ...held.item, setup: next.stage === "running" ? null : { id: next.id, kind: next.kind, stage: next.stage, issue: next.issue, signer: next.signer } };
  // A start is a paused copy in the portfolio from the moment it is
  // prepared, until it runs (繼續設定 resumes it, 重新開始 / 取消設定 end it).
  if (next.kind === "start" && next.stage !== "running" && next.stage !== "cancelled") setupItems.set(next.strategyId, setupItem(next));
  if (next.stage === "running") setupItems.delete(next.strategyId);
  persist();
  return next;
}
/** As the api's cancel: a start that never ran stops; a deposit that
 * arrived stays in the copy account, to be returned (sweeping). */
function end(setup: LiveCopySetup): LiveCopySetup {
  const ended = save({ ...setup, stage: "cancelled", consent: null, pendingSignature: null, ...(["provisioning", "awaiting_consent"].includes(setup.stage) ? { issue: null } : {}) });
  if (setup.kind === "start") {
    const item = setupItems.get(setup.strategyId);
    if (item && setup.funding?.status === "credited") setupItems.set(setup.strategyId, { ...item, status: "stopped", stage: "sweeping", setup: null });
    else setupItems.delete(setup.strategyId);
    persist();
  }
  return ended;
}
function find(id: string) {
  const setup = setups.get(id);
  if (!setup) throw new ApiError(404, "Setup not found");
  return setup;
}
function change(kind: "edit" | "renewal", strategyId: number, body: Record<string, unknown>) {
  const held = strategies.get(strategyId);
  if (!held) throw new ApiError(404, "Copy not found");
  const setup: LiveCopySetup = { id: uuid(), kind, strategyId, accountId: held.item.accountId, leaderAddress: held.item.leaderAddress, sourceNetwork: held.item.sourceNetwork,
    budgetUsd: kind === "edit" ? String(body.budgetUsd) : held.item.budgetUsd, settings: (kind === "edit" ? body.settings : held.strategy.settings) as LiveCopySetup["settings"],
    stage: "awaiting_consent", issue: null, signer: null, consent: null, funding: null, pendingSignature: null, mandateId: null, setupDeadline: null, createdAt: iso(), updatedAt: iso() };
  return save({ ...setup, consent: consent(setup) });
}

/** What blocks DELETE /me in the fixture's testnet state, as the api
 * decides it: a setup still going, a copy still running, then funds left in
 * a copy account (a start that ended after its deposit arrived). */
export function fixtureLiveDeletionBlockers(): { code: string; strategyIds: number[] }[] {
  if (!liveFixtureEnabled()) return [];
  load();
  const items = [...strategies.values()].map(held => held.item).concat([...setupItems.values()]);
  const ids = (list: LiveCopyPortfolioItem[]) => list.map(item => item.strategyId).sort((a, b) => a - b);
  const going = items.filter(item => item.setup && !["running", "failed", "expired", "cancelled", "provisioning", "awaiting_consent"].includes(item.setup.stage));
  const running = items.filter(item => item.status !== "stopped" && !(item.setup && ["provisioning", "awaiting_consent", "failed", "expired"].includes(item.setup.stage)));
  const funded = items.filter(item => (item.status === "stopped" && item.stage === "sweeping") ||
    (item.setup && ["failed", "expired"].includes(item.setup.stage) && setups.get(item.setup.id)?.funding?.status === "credited"));
  return [["copies_active", running], ["setup_in_progress", going], ["copy_account_not_empty", funded]].flatMap(([code, list]) =>
    (list as LiveCopyPortfolioItem[]).length ? [{ code: code as string, strategyIds: ids(list as LiveCopyPortfolioItem[]) }] : []);
}

/** The live routes under /me/copy/live with their response contract, or
 * undefined for any other path. */
export function fixtureLiveCopy(method: string, parts: string[], body: unknown): { schema: ZodTypeAny; value: unknown } | undefined {
  if (!liveFixtureEnabled() || parts[0] !== "me" || parts[1] !== "copy" || parts[2] !== "live") return undefined;
  load();
  const value = liveRoute(method, parts, body);
  if (value === undefined) return undefined;
  const area = parts[3] ?? "";
  const schema = area === "" ? liveCopyOverviewSchema : area === "portfolio" ? liveCopyPortfolioSchema : area === "mandates" ? liveCopyMandateSchema
    : area === "setups" && parts.length === 4 && method === "GET" ? liveCopySetupsSchema : liveCopySetupSchema;
  return { schema, value };
}
function liveRoute(method: string, parts: string[], body: unknown): unknown {
  const rest = parts.slice(3), input = (body ?? {}) as Record<string, unknown>;
  const route = `${method} ${rest.map((p, i) => (i === 1 && ["setups", "strategies", "mandates"].includes(rest[0]!) ? ":id" : p)).join("/")}`;
  switch (route) {
    case "GET ": return { mode: "actual", network: "testnet", capabilities: { strategyPreparation: true, automaticExecution: true, sourceNetworks: ["mainnet", "testnet"] },
      strategies: [...strategies.values()].map(held => held.strategy), mandates: [] };
    case "GET portfolio": return { network: "testnet", automaticExecution: true, items: [...strategies.values()].map(held => held.item).concat([...setupItems.values()]).reverse() };
    case "GET setups": return { items: [...setups.values()].reverse() };
    case "POST setups": {
      const priorId = startKeys.get(String(input.idempotencyKey)), prior = priorId ? setups.get(priorId) : undefined;
      if (prior) return prior.stage === "awaiting_consent" ? save({ ...prior, consent: consent(prior) }) : prior;
      if ([...strategies.values()].some(held => held.item.leaderAddress === input.leader && held.item.status !== "stopped")) throw new ApiError(409, "Already copying", { code: "already_copying" });
      // A start for this trader that ended, or never got its consent, ends first.
      for (const other of [...setups.values()]) {
        if (other.kind === "start" && other.leaderAddress === input.leader && ["provisioning", "awaiting_consent", "failed", "expired"].includes(other.stage)) end(other);
        else if (other.kind === "start" && other.leaderAddress === input.leader && other.stage !== "running" && other.stage !== "cancelled") throw new ApiError(409, "Already copying", { code: "already_copying" });
      }
      const setup = { id: uuid(), kind: "start" as const, strategyId: nextStrategy++, accountId: null, leaderAddress: String(input.leader), sourceNetwork: "mainnet" as const,
        budgetUsd: String(input.budgetUsd), settings: input.settings as LiveCopySetup["settings"], stage: "awaiting_consent" as const, issue: null, signer: null, consent: null, funding: null,
        pendingSignature: null, mandateId: null, setupDeadline: null, createdAt: iso(), updatedAt: iso() };
      startKeys.set(String(input.idempotencyKey), setup.id);
      const saved = save({ ...setup, accountId: `acct-${setup.strategyId}` });
      return save({ ...saved, consent: consent(saved) });
    }
    // A read moves the worker's stages on; the owner-signed ones move only
    // with /advance and the signature of the pending action.
    case "GET setups/:id": { const setup = find(rest[1]!); return setup.signer === "owner_session" && (OWNER_STEPS[setup.stage] || setup.stage === "agent_active") ? setup : step(setup); }
    case "POST setups/:id/advance": return step(find(rest[1]!), input);
    case "POST setups/:id/confirm": {
      const setup = find(rest[1]!);
      if (setup.stage !== "awaiting_consent") return setup;
      if (setup.kind === "start" && typeof input.fundingSignature !== "string") throw new ApiError(400, "The deposit signature is required");
      // As the api: the worker signs only when Privy shows exactly it under
      // the consented policy on the copy account (the browser added it).
      const consented = setup.consent, signers = consented ? fixtureSigners.get(consented.accountAddress) : undefined;
      const attached = Boolean(consented?.masterPolicyId && signers?.length === 1 && signers[0]!.signerId === consented.workerQuorumId &&
        signers[0]!.policyIds.length === 1 && signers[0]!.policyIds[0] === consented.masterPolicyId);
      return save({ ...setup, consent: null, signer: attached || setup.kind === "edit" && strategies.has(setup.strategyId) ? "worker_policy" : "owner_session", setupDeadline: iso(Date.now() + 86_400_000), stage: setup.kind === "start" ? "funding_submitted" : "consented",
        issue: setup.kind === "start" ? "awaiting_credit" : null });
    }
    case "POST setups/:id/cancel": {
      const setup = find(rest[1]!);
      if (setup.stage === "cancelled") return setup;
      if (!["provisioning", "awaiting_consent", "failed", "expired"].includes(setup.stage)) throw new ApiError(409, "The deposit was already sent", { code: "funding_pending" });
      return end(setup);
    }
    case "PATCH strategies/:id": return change("edit", Number(rest[1]), input);
    case "POST strategies/:id/renew": return change("renewal", Number(rest[1]), input);
    case "POST mandates/:id/pause": case "POST mandates/:id/resume": {
      const held = [...strategies.values()].find(entry => entry.item.mandate?.id === rest[1]);
      if (!held) throw new ApiError(404, "Mandate not found");
      const paused = rest[2] === "pause";
      held.item = { ...held.item, status: paused ? "paused" : "active", stage: paused ? "paused" : "active", mandate: { ...held.item.mandate!, state: paused ? "paused" : "active", revision: held.item.mandate!.revision + 1 } };
      return { id: held.item.mandate!.id, accountId: held.item.accountId, strategyId: held.item.strategyId, mode: "actual", network: "testnet", accountAddress: ACCOUNT, sourceNetwork: held.item.sourceNetwork,
        leaderAddress: held.item.leaderAddress, budgetUsd: held.item.budgetUsd, strategyVersion: held.strategy.version, state: paused ? "paused" : "active", revision: held.item.mandate!.revision,
        activationCursor: held.item.createdAt, expiresAt: held.item.expiresAt!, createdAt: held.item.createdAt, updatedAt: iso() };
    }
    default: return undefined;
  }
}
