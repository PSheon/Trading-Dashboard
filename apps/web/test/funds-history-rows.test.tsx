import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { FundsHistory } from "@/components/wallet/funds-history";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import { isReturnFlow, walletAmount, type FundsFlowView } from "@/lib/funds";

/**
 * 資金紀錄 (audit 2026-10-07 P1-9): 模擬 rows are tagged, amounts are signed
 * as the owner's own money sees them (a funding out of the main wallet is −,
 * a return +), each copy is named by its trader, and the ledger-window line
 * ("帳本查詢起點…") is gone.
 */
const owner = `0x${"11".repeat(20)}`, account = `0x${"cc".repeat(20)}`, leader = `0x${"44".repeat(20)}`;
const flow = (over: Partial<FundsFlowView>): FundsFlowView => ({ id: Math.random().toString(36), time: "2026-10-05T01:00:00.000Z", kind: "copy_funding", mode: "mainnet", amount: 50,
  strategyId: 902, leaderAddress: leader, status: "credited", txHash: null, fee: null, counterparty: account, count: null, ...over });
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/settings", useSearchParams: () => new URLSearchParams() }));
const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", wallet: { address: owner } }) }));
vi.mock("@/lib/funds", async () => ({ ...(await vi.importActual<typeof import("@/lib/funds")>("@/lib/funds")),
  useFundsHistory: () => ({ data: { pages: [{ items: state.items, nextCursor: null }] }, hasNextPage: false, isPending: false, isError: false }) }));
vi.mock("@/lib/wallet", () => ({ useWalletHistory: () => ({ data: { transfers: [], from: "2026-07-09T03:01:00.000Z", fetchedAt: "2026-10-07T03:01:00.000Z", network: "mainnet", address: owner }, isPending: false, isError: false }) }));
vi.mock("@/components/wallet/history-list", () => ({ ICON: {}, WithdrawalNotices: () => null, kindOf: () => "other" }));
vi.mock("@/components/copy/copy-portfolio", () => ({ useLeaders: () => new Map([[leader, { address: leader, displayName: "Kinetiq", avatarUrl: null }]]) }));

it("signs every amount from the owner's wallet, tags 模擬 rows, names the trader and drops the ledger-window line", () => {
  state.items = [
    flow({ id: "return", amount: 10, counterparty: owner, time: "2026-10-06T00:00:00.000Z" }),
    flow({ id: "deposit" }),
    flow({ id: "paper", kind: "copy_deposit", mode: "paper", amount: 150, counterparty: "paper", status: null, time: "2026-10-04T00:00:00.000Z" }),
  ];
  const html = renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}><FundsHistory /></I18nProvider>);
  expect(html).toContain("從跟單 Kinetiq 返還主錢包");
  expect(html).toContain("轉入跟單 Kinetiq 錢包");
  expect(html).toContain("加碼至跟單 Kinetiq");
  expect(html).not.toMatch(/#902|#\d/);
  expect(html).toContain("+$10.00");
  expect(html).toContain("-$50.00");
  expect(html).toContain("-$150.00");
  expect(html.match(/data-testid="paper-tag"/g)).toHaveLength(1);
  expect(html).not.toContain("帳本查詢起點");
});

it("walletAmount / isReturnFlow: out of the wallet −, back into it +; fees as recorded", () => {
  expect(walletAmount(flow({}), owner)).toBe(-50);
  expect(walletAmount(flow({ counterparty: owner.toUpperCase().replace("0X", "0x") }), owner)).toBe(50);
  expect(isReturnFlow(flow({ counterparty: owner }), owner)).toBe(true);
  expect(walletAmount(flow({ kind: "copy_withdrawal", mode: "paper", amount: -20 }), owner)).toBe(20);
  expect(walletAmount(flow({ kind: "fees", mode: "paper", amount: -0.42 }), owner)).toBe(-0.42);
  expect(walletAmount(flow({ kind: "hub_withdrawal", amount: -20, counterparty: owner }), owner)).toBe(-20);
});
