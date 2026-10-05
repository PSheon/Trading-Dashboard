// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyAgentSettings } from "@/components/settings/copy-agents";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { catalogs } from "@/i18n/messages";
import { LOCALES, type Locale } from "@/i18n/config";
import type { CopyAgentOverview, CopyAgentSetup, CopyExecutionAccount } from "@trading-dashboard/shared/contracts";
import { settleQueries, type SettleOptions } from "./query-settle";
import { chooseOption, selectTrigger } from './select-helper';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sign: vi.fn(), status: "signedIn", mode: "privy", identity: "owner", session: "1", walletAddress: `0x${"11".repeat(20)}` as string | null }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: state.status, mode: state.mode, identity: state.identity, wallet: state.walletAddress ? { address: state.walletAddress, signTypedData: state.sign } : null }) }));
vi.mock("@/lib/api", () => ({ api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
vi.mock("@/lib/query-policy", () => ({ defaultRetry: { retry: false } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const account: CopyExecutionAccount = { id: "account", strategyId: 9, network: "testnet", state: "ready", address: `0x${"22".repeat(20)}`, issue: null, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
function setup(state: CopyAgentSetup["state"] = "ready"): CopyAgentSetup { return { id: "agent", accountId: account.id, strategyId: 9, network: "testnet", state, accountAddress: account.address!, agentAddress: `0x${"33".repeat(20)}`, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), issue: null, authorizationId: state === "active" ? "grant" : null, createdAt: account.createdAt, updatedAt: account.updatedAt }; }
let root: Root, container: HTMLDivElement, client: QueryClient, data: CopyAgentOverview;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.sessionStorage.clear(); Object.assign(state, { status: "signedIn", mode: "privy", identity: "owner", session: "1", walletAddress: `0x${"11".repeat(20)}` }); state.get.mockReset(); state.post.mockReset(); state.sign.mockReset().mockResolvedValue(`0x${"aa".repeat(65)}`); data = { available: true, network: "testnet", setups: [] }; state.get.mockImplementation(async () => data); client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });
// Waits for the agent queries and mutations to answer (advancing fake timers when on);
// settleHeld() waits for queries only, while a test holds a signature or POST open.
const settle = (options?: SettleOptions) => settleQueries(client, { ms: 20, ...options });
const settleHeld = () => settle({ mutations: false });
async function render(locale: Locale = "en", accounts = [account], wait: () => Promise<void> = settle) { await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale={locale} messages={catalogs[locale]}><CopyAgentSettings accounts={accounts} /></I18nProvider></QueryClientProvider>)); await wait(); }
function button(label: string) { const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label); if (!found) throw new Error(`Missing button ${label}`); return found; }
async function click(label: string, wait: () => Promise<void> = settle) { await act(async () => button(label).click()); await wait(); }
async function selectAccount() { await chooseOption(selectTrigger(container), account.id); await settle(); }
async function acknowledge() { await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); await settle(); }

it("creates a separate agent without signing and requires explicit reviewed owner consent", async () => {
  await render(); expect(state.post).not.toHaveBeenCalled(); expect(state.sign).not.toHaveBeenCalled(); await selectAccount();
  const op = setup(); state.post.mockImplementation(async (path: string) => { if (path.endsWith("/agent")) { data.setups = [op]; return op; } if (path.endsWith("/challenge")) { const nonce = Date.now(); return { operation: op, intent: { id: op.id, strategyId: op.strategyId, network: op.network, accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: "policy", workerQuorumId: "worker", nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } }; } data.setups = [{ ...op, state: "active", authorizationId: "grant" }]; return data.setups[0]; });
  await click("Prepare agent"); expect(state.post).toHaveBeenCalledTimes(1); expect(state.sign).not.toHaveBeenCalled(); expect(button("Confirm and sign approval").disabled).toBe(true);
  expect(container.textContent).toContain(account.address); expect(container.textContent).toContain(op.agentAddress); expect(container.textContent).toContain(state.walletAddress); await acknowledge(); await click("Confirm and sign approval");
  expect(state.sign).toHaveBeenCalledOnce(); expect(state.sign.mock.calls[0][0].primaryType).toBe("CopyAgentConsent"); expect(state.post.mock.calls.map(([path]) => path)).toEqual(["/me/copy/execution-wallets/account/agent", "/me/copy/agents/agent/challenge", "/me/copy/agents/agent/approve"]);
  expect(state.post.mock.calls[2][1]).toEqual({ consentSignature: `0x${"aa".repeat(65)}` }); expect(container.textContent).toContain("Delegation approved"); expect(container.textContent).toContain("Copying still runs in paper mode"); expect(container.querySelector('input[type="checkbox"]')).toBeNull();
});
it("preserves an unresolved setup key through unmount and uses only an explicit original retry", async () => {
  state.post.mockRejectedValue(new Error("private remote detail")); await render(); await selectAccount(); await click("Prepare agent"); const original = state.post.mock.calls[0].slice(0, 2); expect(container.textContent).not.toContain("private remote");
  await act(async () => root.unmount()); client.clear(); root = createRoot(container); await render(); expect(state.post).toHaveBeenCalledTimes(1); await click("Check original setup"); expect(state.post.mock.calls[1].slice(0, 2)).toEqual(original); expect(state.sign).not.toHaveBeenCalled();
});
it("recovers uncertain approval after reload even if the last overview still says ready", async () => {
  const op = setup(); data.setups = [op]; state.post.mockImplementation(async (path: string) => { if (path.endsWith("/challenge")) { const nonce = Date.now(); return { operation: op, intent: { id: op.id, strategyId: 9, network: "testnet", accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: "policy", workerQuorumId: "worker", nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } }; } throw new Error("lost"); });
  await render(); await acknowledge(); await click("Confirm and sign approval"); expect(state.sign).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount()); client.clear(); root = createRoot(container); await render(); expect(container.querySelector('input[type="checkbox"]')).toBeNull(); const before = state.post.mock.calls.length; state.post.mockResolvedValue({ ...op, state: "approval_unknown" }); await click("Check original setup"); expect(state.post.mock.calls.slice(before).map(([path, body]) => [path, body])).toEqual([["/me/copy/agents/agent/reconcile", {}]]); expect(state.sign).toHaveBeenCalledTimes(1);
});
it.each(["approval_unknown", "wallet_unknown", "revoked", "expired"] as const)("shows %s without an approval control or automatic mutation", async (status) => {
  data.setups = [setup(status)]; await render(); expect(container.querySelector('input[type="checkbox"]')).toBeNull(); expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Confirm and sign approval")).toBe(false); expect(state.post).not.toHaveBeenCalled(); expect(state.sign).not.toHaveBeenCalled(); expect(container.textContent).toContain(status === "revoked" ? en.copyAgents.states.revoked : status === "expired" ? "Expired" : "Check original setup");
});
it("guards the session while signing and hides the former owner's controls", async () => {
  data.setups = [setup()]; let complete!: (value: string) => void; state.sign.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const op = data.setups[0]; const nonce = Date.now(); state.post.mockResolvedValue({ operation: op, intent: { id: op.id, strategyId: 9, network: "testnet", accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: "policy", workerQuorumId: "worker", nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } });
  await render(); await acknowledge(); await click("Confirm and sign approval", settleHeld); state.session = "2"; state.identity = "other"; data.setups = []; await render("en", [account], settleHeld); await act(async () => complete(`0x${"aa".repeat(65)}`)); await settle(); expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/agents/agent/challenge", {}, { beforeSend: expect.any(Function) }); expect(container.textContent).not.toContain(op.agentAddress);
});
it("provides labelled controls and recovery without a main signing wallet", async () => {
  data.setups = [setup("approval_unknown")]; state.walletAddress = null; state.post.mockResolvedValue(data.setups[0]); await render(); const section = container.querySelector("section")!; expect(section.getAttribute("aria-label")).toBe("Strategy agent approval"); await click("Check original setup"); expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/agents/agent/reconcile", {}, { beforeSend: expect.any(Function) }); expect(state.sign).not.toHaveBeenCalled();
});
it.each([{ status: "signedOut" }, { mode: "fixture" }, { walletAddress: null }])("does not permit owner actions for %j", async (change) => {
  Object.assign(state, change); await render(); expect(state.post).not.toHaveBeenCalled(); expect(container.querySelector("form")).toBeNull(); if (change.status === "signedOut") expect(state.get).not.toHaveBeenCalled();
});

it("does not discard a replacement setup identity after a timeout", async () => {
  data.setups = [setup("revoked")]; state.post.mockRejectedValue(new Error("lost")); await render(); await selectAccount(); await click("Prepare replacement agent"); const original = state.post.mock.calls[0].slice(0, 2);
  await act(async () => root.unmount()); client.clear(); root = createRoot(container); await render(); await selectAccount(); expect(button("Prepare replacement agent").disabled).toBe(true);
  const checks = [...container.querySelectorAll("button")].filter((item) => item.textContent === "Check original setup"); await act(async () => checks[0].click()); await settle(); expect(state.post.mock.calls[1].slice(0, 2)).toEqual(original); expect(state.sign).not.toHaveBeenCalled();
});
it.each(["wallet", "account"] as const)("blocks approval when the %s changes during signing without a session generation change", async (change) => {
  const op = setup(); data.setups = [op]; let complete!: (value: string) => void; state.sign.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const nonce = Date.now(); state.post.mockResolvedValue({ operation: op, intent: { id: op.id, strategyId: 9, network: "testnet", accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: "policy", workerQuorumId: "worker", nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } });
  await render(); await acknowledge(); await click("Confirm and sign approval", settleHeld); if (change === "wallet") state.walletAddress = `0x${"44".repeat(20)}`;
  await render("en", change === "account" ? [{ ...account, address: `0x${"55".repeat(20)}` }] : [account], settleHeld); await act(async () => complete(`0x${"aa".repeat(65)}`)); await settle(); expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/agents/agent/challenge", {}, { beforeSend: expect.any(Function) });
});
it.each(LOCALES)("renders translated states and associated form labels in %s", async (locale) => {
  data.setups = [setup("revoked")]; await render(locale); expect(container.querySelector("section")!.getAttribute("aria-label")).toBe(catalogs[locale].copyAgents.title); expect(container.textContent).toContain(catalogs[locale].copyAgents.states.revoked);
  expect(container.querySelectorAll('[data-slot="select-trigger"], input')).toHaveLength(2);
  for (const control of container.querySelectorAll('[data-slot="select-trigger"], input')) { expect(control.id).not.toBe(""); expect([...container.querySelectorAll("label")].find((label) => label.htmlFor === control.id)?.textContent).toBeTruthy(); }
  expect(state.post).not.toHaveBeenCalled();
});
it("hides approval for mainnet, unavailable providers and elapsed expiries", async () => {
  data = { available: false, network: "mainnet", setups: [{ ...setup(), network: "mainnet" }] }; await render(); expect(container.querySelector("form")).toBeNull(); expect(container.querySelector('input[type="checkbox"]')).toBeNull(); expect(container.textContent).toContain(en.copyAgents.unavailable);
  data = { available: true, network: "testnet", setups: [{ ...setup(), expiresAt: new Date(Date.now() - 1000).toISOString() }] }; await act(async () => { await client.invalidateQueries(); }); await settle(); expect(container.querySelector('input[type="checkbox"]')).toBeNull(); expect(container.textContent).toContain(en.copyAgents.states.expired); expect(state.sign).not.toHaveBeenCalled();
});

const transitionCases = (["challenge", "signature"] as const).flatMap((gate) =>
  (["approval_unknown", "approval_signing", "revoked", "blocked", "active", "expired", "address", "expiry"] as const).map((change) => ({ gate, change })));
it.each(transitionCases)("blocks the held $gate after a current $change transition", async ({ gate, change }) => {
  const op = setup(); data.setups = [op];
  const nonce = Date.now();
  const challenge = { operation: op, intent: { id: op.id, strategyId: op.strategyId, network: op.network, accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: "policy", workerQuorumId: "worker", nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } };
  let finishChallenge!: (value: typeof challenge) => void;
  let finishSignature!: (value: string) => void;
  state.post.mockImplementation((path: string) => path.endsWith("/challenge")
    ? gate === "challenge" ? new Promise((resolve) => { finishChallenge = resolve; }) : Promise.resolve(challenge)
    : Promise.resolve({ ...op, state: "active", authorizationId: "grant" }));
  if (gate === "signature") state.sign.mockImplementation(() => new Promise((resolve) => { finishSignature = resolve; }));
  await render(); await acknowledge(); await click("Confirm and sign approval", settleHeld);
  const changed = change === "address" ? { ...op, agentAddress: `0x${"44".repeat(20)}` }
    : change === "expiry" ? { ...op, expiresAt: new Date(Date.parse(op.expiresAt) - 1000).toISOString() }
    : { ...op, state: change };
  data = { ...data, setups: [changed] };
  await act(async () => { await client.invalidateQueries(); }); await settleHeld();
  await act(async () => { if (gate === "challenge") finishChallenge(challenge); else finishSignature(`0x${"aa".repeat(65)}`); }); await settle();
  expect(state.post).toHaveBeenCalledExactlyOnceWith("/me/copy/agents/agent/challenge", {}, { beforeSend: expect.any(Function) });
  expect(state.sign).toHaveBeenCalledTimes(gate === "challenge" ? 0 : 1);
});

it.each(["ready", "active"] as const)("expires an idle visible %s operation without waiting for a query update", async (status) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  data.setups = [{ ...setup(status), expiresAt: new Date(Date.now() + 2000).toISOString() }];
  await render(); const reads = state.get.mock.calls.length;
  expect(container.textContent).toContain(status === "ready" ? en.copyAgents.states.ready : en.copyAgents.states.active);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(container.textContent).toContain(en.copyAgents.states.expired);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.textContent).not.toContain(en.copyAgents.states.active);
  expect(state.get).toHaveBeenCalledTimes(reads); expect(state.post).not.toHaveBeenCalled();
});

it("refreshes the expiry clock when a paused tab regains focus", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  data.setups = [{ ...setup("active"), expiresAt: new Date(Date.now() + 2000).toISOString() }];
  await render();
  vi.setSystemTime(new Date("2026-10-03T00:00:03Z"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).toContain(en.copyAgents.states.expired);
  expect(container.textContent).not.toContain(en.copyAgents.states.active);
  expect(state.post).not.toHaveBeenCalled();
});

it("accepts an already submitted approval response after the overview observes activation", async () => {
  const op = setup(), active = { ...op, state: "active" as const, authorizationId: "grant" }; data.setups = [op];
  const nonce = Date.now(); let finish!: (value: CopyAgentSetup) => void;
  state.post.mockImplementation((path: string) => path.endsWith("/challenge")
    ? Promise.resolve({ operation: op, intent: { id: op.id, strategyId: op.strategyId, network: op.network, accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: "policy", workerQuorumId: "worker", nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } })
    : new Promise((resolve) => { finish = resolve; }));
  await render(); await acknowledge(); await click("Confirm and sign approval", settleHeld);
  expect(state.post).toHaveBeenCalledTimes(2);
  data = { ...data, setups: [active] };
  await act(async () => { await client.invalidateQueries(); }); await settleHeld();
  await act(async () => finish(active)); await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain(en.copyAgents.pendingHint);
  expect(container.textContent).toContain(en.copyAgents.states.active);
});
it("blocks the final approval boundary when a still-ready account version changes during token wait", async () => {
  const op = setup(); data.setups = [op]; let send!: () => void;
  state.post.mockImplementation((path: string, _body: unknown, options?: { beforeSend?: () => void }) => { if (path.endsWith('/challenge')) { const nonce = Date.now(); return Promise.resolve({ operation: op, intent: { id: op.id, strategyId: op.strategyId, network: op.network, accountAddress: op.accountAddress, agentAddress: op.agentAddress, policyId: 'policy', workerQuorumId: 'worker', nonce, expiresAt: Date.parse(op.expiresAt), consentExpiresAt: nonce + 300000 } }); } return new Promise((resolve, reject) => { send = () => { try { options?.beforeSend?.(); resolve({ ...op, state: 'active', authorizationId: 'grant' }); } catch (error) { reject(error); } }; }); });
  await render(); await acknowledge(); await click('Confirm and sign approval', settleHeld); await render('en', [{ ...account, updatedAt: '2026-10-04T00:00:00Z' }], settleHeld); await act(async () => send()); await settle(); expect(container.textContent).not.toContain(en.copyAgents.states.active); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
