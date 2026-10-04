import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { testConfig } from "./config-test-utils.js";
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';
const budget = { acquire: vi.fn(async () => {}), adjust: vi.fn(), onSuccess: vi.fn(), onRateLimited: vi.fn() };
const client = () => new HyperliquidInfoClient(testConfig(), budget as unknown as RequestBudgeterService, undefined, offlineGlobalTransport().transport);
const reply = (value: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(value)));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("rejects a malformed clearinghouse instead of turning it into an empty account", async () => {
  reply({ assetPositions: [], marginSummary: { accountValue: "not-a-number" }, withdrawable: "0" });
  await expect(client().clearinghouseState("0x123")).rejects.toThrow("Invalid Hyperliquid clearinghouseState response");
  expect(budget.onSuccess).not.toHaveBeenCalled();
});
it("rejects numeric corruption in a fill without dropping the affected row", async () => {
  reply([{ coin: "BTC", px: "Infinity", sz: "1", side: "B", time: 1, tid: 1, closedPnl: "0", fee: "0" }]);
  await expect(client().userFills("0x123")).rejects.toThrow("Invalid Hyperliquid userFills response");
});
it("rejects unknown account modes rather than guessing how collateral is counted", async () => {
  reply("newAccountMode");
  await expect(client().userAbstraction("0x123")).rejects.toThrow("Invalid Hyperliquid userAbstraction response");
});
it("accepts forward-compatible extra fields in a valid empty spot account", async () => {
  reply({ balances: [], portfolioMarginEnabled: false, futureField: "preserved" });
  await expect(client().spotClearinghouseState("0x123")).resolves.toMatchObject({ balances: [], futureField: "preserved" });
});

it("preserves valid fill accounting fields and extra source data", async () => {
  const fill = { coin: "BTC", px: "60000.01", sz: "0.01", side: "B", time: 1, tid: 1,
    closedPnl: "-1.5", fee: "0.2", dir: "Open Long", hash: "0xabc", oid: 2, crossed: true,
    startPosition: "0", futureField: { observed: true } };
  reply([fill]);
  await expect(client().userFills("0x123")).resolves.toEqual([fill]);
});
it("bounds response bytes with and without Content-Length", async () => {
  const { readInfoJson } = await import("../src/hyperliquid/response-validation.js");
  await expect(readInfoJson(new Response('"abcd"'), "allMids", 4)).rejects.toThrow("Invalid Hyperliquid allMids response");
  await expect(readInfoJson(new Response('{}', { headers: { 'Content-Length': '100' } }), "allMids", 4)).rejects.toThrow("Invalid Hyperliquid allMids response");
  await expect(readInfoJson(new Response('{}'), "allMids", 4)).resolves.toEqual({});
});
it("rejects bad JSON without reflecting raw upstream text", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('secret-source-payload')));
  await expect(client().allMids()).rejects.toThrow(/^Invalid Hyperliquid allMids response$/);
});
it("requires decimal prices and safe integer fill identifiers", async () => {
  const { validateInfoResponse } = await import("../src/hyperliquid/response-validation.js");
  for (const value of ["NaN", "Infinity", " ", "0x12"]) {
    expect(() => validateInfoResponse("allMids", { BTC: value })).toThrow();
  }
  expect(() => validateInfoResponse("userFills", [{ coin: "BTC", px: "1", sz: "1", side: "B", time: 1,
    tid: Number.MAX_SAFE_INTEGER + 1, closedPnl: "0", fee: "0", dir: "Open Long", hash: "0xabc", oid: 1, crossed: true }])).toThrow();
});
it("validates referral amounts nested inside a ready referrer", async () => {
  const { validateInfoResponse } = await import("../src/hyperliquid/response-validation.js");
  expect(() => validateInfoResponse("referral", { cumVlm: "0", claimedRewards: "0", unclaimedRewards: "0", builderRewards: "0",
    referredBy: null, rewardHistory: [], tokenToState: [], referrerState: { stage: "ready", data: { code: "TEST", referralStates: [{ cumVlm: 123 }] } } })).toThrow();
});

it("accepts captured live spot and referral fixtures", async () => {
  const { validateInfoResponse } = await import("../src/hyperliquid/response-validation.js");
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  expect(() => validateInfoResponse("spotMetaAndAssetCtxs", fixture("spot-valuation-live").spotMetaAndAssetCtxs)).not.toThrow();
  for (const name of ["referral-ready", "referral-ready-with-unclaimed", "referral-need-to-trade", "referral-need-to-create-code"]) {
    expect(() => validateInfoResponse("referral", fixture(name))).not.toThrow();
  }
  const referral = fixture("referral-ready");
  const pair = referral.tokenToState[0];
  expect(validateInfoResponse("referral", { ...referral, tokenToState: pair })).toMatchObject({ tokenToState: [pair] });
});
it("fails closed for undocumented context identity rather than assigning prices by array order", async () => {
  const { validateInfoResponse } = await import("../src/hyperliquid/response-validation.js");
  // The published example omits coin; observed live arrays are not index-aligned.
  // Without identity there is no safe way to assign the mark price to a pair.
  expect(() => validateInfoResponse("spotMetaAndAssetCtxs", [{ tokens: [], universe: [] }, [{ markPx: "0.14", midPx: "0.209265" }]])).toThrow();
});

it("validates funding payments before attribution", async () => {
  const { validateInfoResponse } = await import("../src/hyperliquid/response-validation.js");
  const entry = { time: 1, hash: "0x0", delta: { type: "funding", coin: "BTC", usdc: "-0.25", szi: "1", fundingRate: "0.001", nSamples: null } };
  expect(validateInfoResponse("userFunding", [entry])).toEqual([entry]);
  expect(() => validateInfoResponse("userFunding", [{ ...entry, delta: { ...entry.delta, usdc: "NaN" } }])).toThrow();
});
