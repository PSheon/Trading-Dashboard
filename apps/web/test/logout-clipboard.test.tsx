// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** Web audit L1 and L2: a rejected Privy logout or clipboard write is said
 * (a toast), never an unhandled rejection or silence; 登出 shows it is busy. */
const state = vi.hoisted(() => ({ logout: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ logout: state.logout }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ error: state.error, success: vi.fn(), info: vi.fn() }) }));
vi.mock("@/i18n/provider", () => ({ useI18n: () => ({ t: (key: string) => key, locale: "en" }) }));

const { useLogout } = await import("@/lib/use-logout");
const { useCopy } = await import("@/components/wallet/bits");
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("a logout Privy rejects is a toast, and the button is busy until it answers", async () => {
  let fail!: (error: Error) => void;
  state.logout.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const seen: { current: ReturnType<typeof useLogout> | null } = { current: null };
  function Probe() { const value = useLogout(); useLayoutEffect(() => { seen.current = value; }); return null; }
  await act(async () => root.render(<Probe />));
  let done!: Promise<void>;
  await act(async () => { done = seen.current!.logout(); });
  expect(seen.current!.pending).toBe(true);
  await act(async () => { fail(new Error("iframe blocked")); await done; });
  expect(state.error).toHaveBeenCalledWith("common.errors.failed");
  expect(seen.current!.pending).toBe(false);
});

it("a clipboard that refuses (or is missing) is said, not swallowed", async () => {
  const seen: { copy: ((value: string) => void) | null } = { copy: null };
  function Probe() { const [, copy] = useCopy(); useLayoutEffect(() => { seen.copy = copy; }); return null; }
  await act(async () => root.render(<Probe />));
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
  await act(async () => { seen.copy!("0xabc"); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(state.error).toHaveBeenCalledWith("common.copyFailed");
  vi.stubGlobal("navigator", {});
  await act(async () => { seen.copy!("0xabc"); });
  expect(state.error).toHaveBeenCalledTimes(2);
});
