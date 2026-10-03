// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExportKeyDialog } from "../src/components/wallet/export-key-dialog";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";

const state = vi.hoisted(() => ({
  status: "signedIn", wallet: null as { address: string | null; exportKey: () => Promise<void> } | null,
  errors: [] as string[], calls: [] as string[],
}));
vi.mock("../src/lib/auth", () => ({ useAuth: () => state }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/components/ui/toast", () => ({ useToast: () => ({ error: (message: string) => state.errors.push(message) }) }));
const ADDRESS = "0x1111111111111111111111111111111111111111";
let root: Root;
let container: HTMLDivElement;
function View() {
  const [open, setOpen] = useState(true);
  return <I18nProvider locale="en" messages={en}><ExportKeyDialog open={open} onOpenChange={setOpen} /></I18nProvider>;
}
async function render() { await act(async () => root.render(<View />)); }
function button() { return [...document.querySelectorAll("button")].find((item) => item.textContent === en.wallet.exportCta)!; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.calls = []; state.errors = []; state.status = "signedIn";
  state.wallet = { address: ADDRESS, exportKey: async () => { state.calls.push(ADDRESS); } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("shows the exact target address and opens Privy only after an explicit click", async () => {
  await render();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(ADDRESS);
  expect(state.calls).toEqual([]);
  await act(async () => button().click());
  expect(state.calls).toEqual([ADDRESS]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("disables export when the user is signed out despite a retained wallet", async () => {
  state.status = "signedOut";
  await render();
  expect(button().disabled).toBe(true);
  await act(async () => button().click());
  expect(state.calls).toEqual([]);
});

it("disables export without an identified wallet", async () => {
  state.wallet!.address = null;
  await render();
  expect(button().disabled).toBe(true);
  expect(document.body.textContent).toContain(en.wallet.noWallet);
});

it("allows retry after failure without displaying provider error details", async () => {
  const sensitive = "provider diagnostic: test-secret-never-display";
  state.wallet!.exportKey = async () => { throw new Error(sensitive); };
  await render();
  await act(async () => button().click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button().disabled).toBe(false);
  expect(state.errors.length).toBe(1);
  expect(state.errors[0]).not.toContain(sensitive);
  state.wallet!.exportKey = async () => { state.calls.push(ADDRESS); };
  await act(async () => button().click());
  expect(state.calls).toEqual([ADDRESS]);
});

it("prevents duplicate exports before the busy state renders", async () => {
  let finish!: () => void;
  state.wallet!.exportKey = () => { state.calls.push(ADDRESS); return new Promise<void>((resolve) => { finish = resolve; }); };
  await render();
  const exportButton = button();
  await act(async () => { exportButton.click(); exportButton.click(); });
  expect(state.calls).toEqual([ADDRESS]);
  await act(async () => finish());
});

it("does not reopen an old user's export dialog when a delayed operation fails", async () => {
  let fail!: (reason: Error) => void;
  state.wallet!.exportKey = () => new Promise<void>((_, reject) => { fail = reject; });
  await render();
  await act(async () => button().click());
  state.wallet = null; state.status = "signedOut";
  await render();
  await act(async () => fail(new Error("old session")));
  expect(state.errors).toEqual([]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
