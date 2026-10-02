// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/i18n/messages/en";
import { zhTW } from "@/i18n/messages/zh-TW";
import { I18nProvider, type Translate } from "@/i18n/provider";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  mutate: vi.fn(),
  error: null as null | { code?: string; message: string },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => "/admin/copy" }));
vi.mock("@/lib/auth", () => ({ usePermission: (p: string) => state.permissions.includes(p) }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries() {}, setQueryData() {} }),
  useMutation: () => ({ mutate: state.mutate, isPending: false, isError: state.error !== null, error: state.error, reset() {} }),
}));

import { ControlDialog, type ControlRequest } from "@/components/admin/copy/control-dialog";
import { ControlButtons } from "@/components/admin/copy/shared";
import { CONTROL_CONFIRM_WORD, copyReasonText, signalLagSeconds } from "@/lib/admin-copy";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function translator(messages: Record<string, unknown>): Translate {
  return ((key: string, values?: Record<string, string | number>) => {
    const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
    if (typeof text !== "string") return key;
    return text.replace(/\{(\w+)\}/g, (match, name: string) => (values && name in values ? String(values[name]) : match));
  }) as Translate;
}

describe("order reason codes", () => {
  const t = translator(en);
  it("reads every shape of code the api writes", () => {
    expect(copyReasonText("stale_signal", t)).toBe("Signal was too old");
    expect(copyReasonText("platform_paused", t)).toBe("Platform has paused new risk");
    expect(copyReasonText("below_min_after_max_strategy_exposure", t)).toBe("Under the minimum order after the strategy exposure cap");
    expect(copyReasonText("user_paused_before_submit", t)).toBe("User stopped before submission");
    expect(copyReasonText("platform_reduce_only_before_submit", t)).toBe("Platform stopped before submission");
    expect(copyReasonText("platform_close_positions", t)).toBe("Cancelled by the Platform-level “Close all positions”");
    expect(copyReasonText("user_pause_new_risk", t)).toBe("Cancelled by the User-level “Pause new risk”");
    expect(copyReasonText("strategy_pause", t)).toBe("Cancelled by the Strategy-level “Pause new risk”");
    expect(copyReasonText("strategy_stop", t)).toBe("Cancelled by the Strategy-level “Close all positions”");
  });
  it("reads a liquidation and the orders it cancelled", () => {
    expect(copyReasonText("liquidated:equity 45.25 < maintenance 50.63", t)).toBe("Liquidated (equity 45.25 < maintenance 50.63)");
    expect(copyReasonText("liquidated", t)).toBe("Cancelled: the strategy was liquidated");
    expect(copyReasonText("liquidated:equity 45.25 < maintenance 50.63", translator(zhTW))).toBe("強制平倉（equity 45.25 < maintenance 50.63）");
  });

  it("shows a code it does not know as it is, and nothing as a dash", () => {
    expect(copyReasonText("exchange_said_no", t)).toBe("exchange_said_no");
    expect(copyReasonText(null, t)).toBe("—");
  });
  it("is translated in the source catalog too", () => {
    expect(copyReasonText("below_min_after_available_funds", translator(zhTW))).toBe("受「可用資金」限制後低於最小下單金額");
  });
});

it("signal lag is the age of the oldest waiting signal, or none", () => {
  const now = Date.parse("2026-10-02T00:10:00Z");
  expect(signalLagSeconds(null, now)).toBeNull();
  expect(signalLagSeconds("2026-10-02T00:07:30Z", now)).toBe(150);
  // A clock a little ahead of the api's never shows a negative wait.
  expect(signalLagSeconds("2026-10-02T00:10:02Z", now)).toBe(0);
});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<I18nProvider locale="en" messages={en}>{node}</I18nProvider>); });
  return { container, unmount: () => act(async () => root.unmount()) };
}
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("stop and resume buttons", () => {
  beforeEach(() => { state.permissions = []; });
  const names = ["Pause new risk", "Reduce-only", "Cancel unsent orders", "Close all positions", "Resume"];

  it("a read-only operator can press none of them", async () => {
    const { container, unmount } = await mount(<ControlButtons state={{ pauseNewRisk: true, reduceOnly: false }} onPick={() => {}} />);
    expect(names.map((n) => button(container, n).disabled)).toEqual([true, true, true, true, true]);
    await unmount();
  });

  it("pause and resume are separate grants; resume is offered only when something is stopped", async () => {
    state.permissions = ["execution.pause"];
    const running = await mount(<ControlButtons state={{ pauseNewRisk: false, reduceOnly: false }} onPick={() => {}} />);
    expect(names.map((n) => button(running.container, n).disabled)).toEqual([false, false, false, false, true]);
    await running.unmount();
    state.permissions = ["execution.resume"];
    const paused = await mount(<ControlButtons state={{ pauseNewRisk: true, reduceOnly: false }} onPick={() => {}} />);
    expect(names.map((n) => button(paused.container, n).disabled)).toEqual([true, true, true, true, false]);
    await paused.unmount();
  });
});

describe("the command confirmation", () => {
  beforeEach(() => { state.mutate.mockReset(); state.error = null; });
  const request: ControlRequest = {
    target: { scope: "platform" }, targetLabel: "All users (platform)", command: "close_positions", revision: 7,
    impact: { strategies: 4, users: 3, exposureUsd: 123_456.78 },
  };

  it("needs a reason and the command's word before it can be sent, then sends the revision on screen", async () => {
    const { unmount } = await mount(<ControlDialog request={request} onClose={() => {}} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("sends one reduce-only close for every position in scope");
    expect(dialog.textContent).toContain("$123,456.78");
    const confirm = button(dialog, "Confirm: Close all positions");
    const reason = dialog.querySelector("textarea")!;
    const word = dialog.querySelector("input")!;
    expect(confirm.disabled).toBe(true);
    await type(reason, "Incident 42");
    expect(confirm.disabled).toBe(true);
    await type(word, "close");
    expect(confirm.disabled).toBe(true);
    await type(word, " close all ");
    expect(confirm.disabled).toBe(false);
    await type(reason, "  x ");
    expect(confirm.disabled).toBe(true);
    await type(reason, " Incident 42 ");
    await act(async () => { confirm.click(); });
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate.mock.calls[0][0]).toEqual({ target: { scope: "platform" }, command: "close_positions", reason: "Incident 42", expectedRevision: 7 });
    await unmount();
  });

  it("each command has its own word", () => {
    expect(new Set(Object.values(CONTROL_CONFIRM_WORD)).size).toBe(5);
  });

  it("a stale revision says the state changed; another failure shows the api's message", async () => {
    state.error = { code: "stale_revision", message: "Controls changed since this page loaded" };
    const stale = await mount(<ControlDialog request={request} onClose={() => {}} />);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Another command changed this stop state");
    await stale.unmount();
    state.error = { message: "Service unavailable" };
    const failed = await mount(<ControlDialog request={request} onClose={() => {}} />);
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("The command was not sent: Service unavailable");
    await failed.unmount();
  });
});

describe("orders that keep failing (/admin/copy)", () => {
  it("the fixture's overview carries one, with the contract's shape", async () => {
    const { adminCopyOverviewSchema, COPY_STUCK_ORDER_ATTEMPTS } = await import("@trading-dashboard/shared/contracts");
    const { fixtureAdminCopyOverview } = await import("@/fixtures/admin-copy");
    const overview = adminCopyOverviewSchema.parse(JSON.parse(JSON.stringify(fixtureAdminCopyOverview())));
    expect(overview.stuckOrders).toHaveLength(1);
    expect(overview.stuckOrders![0]).toMatchObject({ id: "9041", coin: "ETH", leg: "close", reduceOnly: true, lastError: "numeric field overflow" });
    expect(overview.stuckOrders![0]!.attempts).toBeGreaterThanOrEqual(COPY_STUCK_ORDER_ATTEMPTS);
    // An older api without the field is still a valid overview.
    const { stuckOrders: _gone, ...old } = JSON.parse(JSON.stringify(fixtureAdminCopyOverview()));
    void _gone;
    expect(adminCopyOverviewSchema.parse(old).stuckOrders).toBeUndefined();
  });

  it("has wording in the source catalog and in English", () => {
    for (const messages of [en, zhTW]) {
      expect(messages.copyAdmin.stuck.title.length).toBeGreaterThan(3);
      expect(messages.copyAdmin.stuck.hint).toContain("{attempts}");
      expect(messages.copyAdmin.leg.liquidation.length).toBeGreaterThan(3);
    }
  });
});
