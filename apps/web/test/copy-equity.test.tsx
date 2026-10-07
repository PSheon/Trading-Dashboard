// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { CopyEquityProbes, useCopiesEquity } from "../src/lib/copy-equity";

/**
 * Stage, 2026-10-07 (B3): the header's pill said $0.00 while 我的資金 said
 * $79.00. Both now read one total: this network's running copies, each by
 * its account snapshot; another network's copy and a stopped one are out.
 */
const items = [
  { strategyId: 1, network: "mainnet", stage: "active", accountId: "a1" },
  { strategyId: 2, network: "testnet", stage: "active", accountId: "a2" },
  { strategyId: 3, network: "mainnet", stage: "stopped", accountId: "a3" },
  { strategyId: 4, network: "mainnet", stage: "paused", accountId: "a4" },
];
const equity: Record<string, string> = { a1: "40.5", a2: "79", a3: "12", a4: "9.5" };
vi.mock("../src/lib/copy-live-portfolio", async (original) => ({
  ...(await original<typeof import("../src/lib/copy-live-portfolio")>()),
  useLiveCopyPortfolio: () => ({ data: { network: "mainnet", automaticExecution: true, items } }),
}));
vi.mock("../src/lib/copy-execution-wallets", () => ({ useExecutionWallets: () => ({ data: { accounts: items.map((i) => ({ id: i.accountId, network: i.network })) } }) }));
vi.mock("../src/lib/copy-follower-snapshot", () => ({ useCopyFollowerSnapshot: (a: { id: string } | null) => ({ data: a ? { status: "observed", metrics: { perpEquity: equity[a.id] } } : undefined }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("counts this network's running copies only, the same total wherever it is read, and drops a copy when its probes leave", async () => {
  const seen: number[] = [];
  function Pill() { const total = useCopiesEquity(); seen.push(total); return <span data-testid="pill">{total}</span>; }
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  // Two probes (the header's and the portfolio's): the copies count once.
  await act(async () => root.render(<><CopyEquityProbes /><CopyEquityProbes /><Pill /></>));
  expect(el.querySelector('[data-testid="pill"]')!.textContent).toBe("50");
  await act(async () => root.render(<Pill />));
  expect(el.querySelector('[data-testid="pill"]')!.textContent).toBe("0");
  await act(async () => root.unmount());
});
