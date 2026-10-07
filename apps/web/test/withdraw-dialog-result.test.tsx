// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WithdrawDialog, withdrawErrorText } from "../src/components/wallet/withdraw-dialog";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

const DEST = `0x${"22".repeat(20)}`;
const state = vi.hoisted(() => ({
  signing: true, posts: [] as string[], release: null as null | (() => void), fail: null as null | Error,
  toasts: [] as Array<[string, string]>, currentFails: false,
}));
const OP = { id: "11111111-1111-4111-8111-111111111111", network: "testnet", address: `0x${"11".repeat(20)}`, destination: `0x${"22".repeat(20)}`, amount: "12.5", nonce: 1780000000000, status: "prepared", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", wallet: state.signing ? { address: `0x${"11".repeat(20)}`, signTypedData: async () => {
  // The wallet's signing step: held until the test lets it finish.
  await new Promise<void>((resolve) => { state.release = resolve; });
  if (state.fail) throw state.fail;
  return `0x${"11".repeat(64)}1b`;
} } : null }) }));
vi.mock("../src/lib/api", () => ({ api: {
  get: async (path: string) => {
    if (path === "/me/wallet/withdrawals/current") { if (state.currentFails) throw Object.assign(new Error("Service Unavailable"), { status: 503 }); return null; }
    if (path === "/me/wallet") return { network: "testnet", address: `0x${"11".repeat(20)}`, hyperliquid: { perpValue: 100, withdrawable: 100, spotUsdc: 0, spotUsdcHold: 0 }, arbitrum: null, totalValue: 100, fetchedAt: "2026-10-03T00:00:00.000Z" };
    throw new Error("unexpected GET " + path);
  },
  post: async (path: string, body: { destination?: string; amount?: string }) => {
    state.posts.push(path);
    if (path === "/me/wallet/withdrawals") return { ...OP, destination: body.destination, amount: body.amount };
    if (path.endsWith("/broadcast")) return { operation: { ...OP, status: "unknown" }, claimed: true };
    if (path.endsWith("/submit")) return { ...OP, status: "accepted" };
    throw new Error("unexpected POST " + path);
  },
}, sessionKey: () => "alice", apiErrorCode: () => undefined, isBusy: () => false }));
vi.mock("../src/components/ui/toast", () => ({ useToast: () => ({
  info: (m: string) => { state.toasts.push(["info", m]); return 7; },
  dismiss() {}, success: (m: string) => state.toasts.push(["success", m]), error: (m: string) => state.toasts.push(["error", m]),
}) }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function View({ mounted = true }: { mounted?: boolean }) {
  const [open, setOpen] = useState(true);
  return <QueryClientProvider client={client}><I18nProvider locale="en" messages={en}>{mounted ? <WithdrawDialog open={open} onOpenChange={setOpen} /> : null}</I18nProvider></QueryClientProvider>;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
async function render() {
  await act(async () => root.render(<View />));
  await act(async () => { await vi.waitFor(() => { if (client.isFetching() > 0) throw new Error("still fetching"); }, { timeout: 5000, interval: 10 }); });
  await settle();
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function startSigning() {
  const [dest, amount] = [...document.querySelectorAll("input")];
  await act(async () => { type(dest!, DEST); type(amount!, "12.5"); });
  const submit = [...document.querySelectorAll("button")].find((b) => b.textContent === en.wallet.withdrawTitle)!;
  await act(async () => submit.click());
  await act(async () => { await vi.waitFor(() => { if (!state.release) throw new Error("not signing yet"); }, { timeout: 3000, interval: 10 }); });
}
const escape = () => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); state.signing = true; state.posts = []; state.release = null; state.fail = null; state.toasts = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

it("stays open while the withdrawal is being signed and sent, then shows the result", async () => {
  await render();
  await startSigning();
  await escape();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => state.release!()); await settle();
  expect(state.posts).toEqual(["/me/wallet/withdrawals", "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/broadcast", "/me/wallet/withdrawals/11111111-1111-4111-8111-111111111111/submit"]);
  expect(state.toasts).toContainEqual(["success", en.wallet.withdrawSent]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("still tells the user the result when the dialog is gone before the withdrawal finishes", async () => {
  await render();
  await startSigning();
  await act(async () => root.render(<View mounted={false} />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => state.release!()); await settle();
  expect(state.toasts).toContainEqual(["success", en.wallet.withdrawSent]);
});

it("reports a failure after the dialog is gone too", async () => {
  await render();
  await startSigning();
  await act(async () => root.render(<View mounted={false} />));
  state.fail = new Error("User rejected the request");
  await act(async () => state.release!()); await settle();
  expect(state.toasts).toContainEqual(["error", en.wallet.rejected]);
});

it("does not call the api's busy, rate-limit or connection failures a signing failure", () => {
  const t = (key: string) => key;
  const status = (code: number) => Object.assign(new Error("Service Unavailable"), { status: code });
  expect(withdrawErrorText(status(429), t as never, "r")).toBe("common.errors.rateLimited");
  expect(withdrawErrorText(status(503), t as never, "r")).toBe("common.errors.busy");
  expect(withdrawErrorText(status(500), t as never, "r")).toBe("common.errors.failed");
  expect(withdrawErrorText(new TypeError("Failed to fetch"), t as never, "r")).toBe("common.errors.failed");
  expect(withdrawErrorText(new Error("withdrawal_unknown"), t as never, "r")).toBe("r");
  expect(withdrawErrorText(new Error("User rejected"), t as never, "r")).toBe("wallet.rejected");
  // The wallet SDK's own English message is never shown.
  expect(withdrawErrorText(new Error("Bad typed data"), t as never, "r")).toBe("common.errors.failed");
});

it("one failed recovery poll after a good read doesn't block withdrawals (web audit M7)", { timeout: 15_000 }, async () => {
  state.currentFails = false;
  await render();
  const submit = () => [...document.querySelectorAll("button")].find((b) => b.textContent === en.wallet.withdrawTitle)!;
  state.currentFails = true;
  await act(async () => { await client.refetchQueries(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
  expect(client.getQueryCache().getAll().some((query) => query.state.status === "error")).toBe(true);
  expect(document.body.textContent).not.toContain(en.common.error);
  const [dest, amount] = [...document.querySelectorAll("input")];
  await act(async () => { type(dest!, DEST); type(amount!, "12.5"); });
  expect(submit().disabled).toBe(false);
  state.currentFails = false;
});

it("keeps the network, destination and fee visible but blocks unavailable signing", async () => {
  state.signing = false; await render();
  const [dest, amount] = [...document.querySelectorAll("input")];
  await act(async () => { type(dest!, DEST); type(amount!, "12.5"); });
  const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === en.wallet.withdrawTitle)!;
  expect(document.body.textContent).toContain("Testnet");
  expect(document.body.textContent).toContain("Arbitrum Sepolia");
  expect(document.body.textContent).toContain("$11.50");
  expect(submit.disabled).toBe(true);
  expect(state.posts).toEqual([]);
});
