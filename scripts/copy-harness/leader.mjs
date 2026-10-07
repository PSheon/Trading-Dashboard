#!/usr/bin/env node
// Copy harness — the controlled leader (testnet only).
//
// A wallet we own places a fixed scenario of market-like IOC orders on
// Hyperliquid testnet, so a copy of it can be checked deterministically
// (scripts/copy-harness/reconcile.mjs) instead of waiting for real traders.
//
// Key: HARNESS_LEADER_PRIVATE_KEY from .env.harness-leader.testnet.local
// (gitignored, 0600); never printed. Run from apps/api (it uses its deps):
//   node ../../scripts/copy-harness/leader.mjs scenario [name] [--coin ETH] [--gap 20] [--dry-run]
//        name: base (default) | reduce-min | burst | refused-open (see SCENARIO_LEGS)
//   node ../../scripts/copy-harness/leader.mjs open <coin> <usd>        (negative usd: short)
//   node ../../scripts/copy-harness/leader.mjs reduce <coin> <fraction>  (reduce-only)
//   node ../../scripts/copy-harness/leader.mjs close <coin>              (reduce-only, all of it)
//   node ../../scripts/copy-harness/leader.mjs refusable [--per-trade 12 --max-per-trade 15]
//   node ../../scripts/copy-harness/leader.mjs send <address> <usdc>
//   node ../../scripts/copy-harness/leader.mjs state
//   node ../../scripts/copy-harness/leader.mjs flatten   (closes whatever it holds: a rerun after an aborted scenario)
// `--dry-run` reads the markets and prints the legs it would trade; nothing is signed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Dependencies resolve from apps/api (this script has no package of its own).
const apiRequire = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const load = (name) => import(pathToFileURL(apiRequire.resolve(name)).href);
const { ExchangeClient, HttpTransport, InfoClient } = await load("@nktkas/hyperliquid");
const { fixedOrderSize } = await import("./checks.mjs");
const { refusableCoin } = await import("./lib.mjs");
const { privateKeyToAccount } = await load("viem/accounts");

const ENV = resolve(import.meta.dirname, "../../.env.harness-leader.testnet.local");
const key = readFileSync(ENV, "utf8").match(/^HARNESS_LEADER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)?.[1];
if (!key) throw new Error(`no HARNESS_LEADER_PRIVATE_KEY in ${ENV}`);
const wallet = privateKeyToAccount(key);
const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });
const exchange = new ExchangeClient({ transport, wallet });
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const DRY = args.includes("--dry-run");
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

/** Hyperliquid prices: at most 5 significant figures and (6 − szDecimals) decimals. */
function priceOf(raw, szDecimals) {
  const decimals = Math.max(0, 6 - szDecimals);
  return Number(Number(raw).toPrecision(5)).toFixed(decimals).replace(/\.?0+$/, "");
}
async function market(coin) {
  const [meta, mids] = await Promise.all([info.meta(), info.allMids()]);
  const index = meta.universe.findIndex((u) => u.name === coin);
  if (index < 0) throw new Error(`no perp ${coin} on testnet`);
  return { index, szDecimals: meta.universe[index].szDecimals, mid: Number(mids[coin]) };
}
/** Scenario 8's coin: the follower's fixed amount can't be sent on it (lib.mjs refusableCoin). */
async function refusable() {
  const [meta, mids] = await Promise.all([info.meta(), info.allMids()]);
  const markets = meta.universe.map((u) => ({ name: u.name, szDecimals: u.szDecimals, mid: Number(mids[u.name] ?? 0), delisted: Boolean(u.isDelisted) }));
  const terms = { perTradeUsd: Number(flag("per-trade", "12")), maxPerTradeUsd: Number(flag("max-per-trade", flag("per-trade", "12"))), minOrderUsd: 10 };
  const pick = refusableCoin(markets, terms, fixedOrderSize);
  if (!pick) throw new Error(`no testnet perp makes a ${terms.perTradeUsd} USD fixed open fall under the minimum within ${terms.maxPerTradeUsd}`);
  return { coin: pick.name, szDecimals: pick.szDecimals, mid: pick.mid, lotUsd: pick.mid / 10 ** pick.szDecimals, terms };
}
async function position(coin) {
  const state = await info.clearinghouseState({ user: wallet.address });
  const p = state.assetPositions.find((a) => a.position.coin === coin);
  return { szi: p ? Number(p.position.szi) : 0, equity: Number(state.marginSummary.accountValue), withdrawable: Number(state.withdrawable) };
}
/** One IOC order for `usd` notional (buy if usd > 0), or `size` coins when given; reduce-only for closes. */
async function trade(coin, { usd, size, reduceOnly = false, label }) {
  const m = await market(coin);
  const buy = size !== undefined ? size > 0 : usd > 0;
  const coins = size !== undefined ? Math.abs(size) : Math.abs(usd) / m.mid;
  const sz = coins.toFixed(m.szDecimals);
  const px = priceOf(m.mid * (buy ? 1.03 : 0.97), m.szDecimals);
  const sentAt = Date.now();
  if (DRY) { log("trade_planned", { label, coin, side: buy ? "buy" : "sell", sz, px, reduceOnly, notionalUsd: Number((Number(sz) * m.mid).toFixed(2)) }); return { planned: true }; }
  const result = await exchange.order({ orders: [{ a: m.index, b: buy, p: px, s: sz, r: reduceOnly, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  const status = result.response.data.statuses[0];
  log("trade", { label, coin, side: buy ? "buy" : "sell", sz, px, reduceOnly, sentAt, status });
  if (status.error) throw new Error(`${label}: ${status.error}`);
  return status;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [command] = args;
if (command === "state") {
  const [state, spot] = await Promise.all([info.clearinghouseState({ user: wallet.address }), info.spotClearinghouseState({ user: wallet.address })]);
  const usdc = spot.balances.find((b) => b.coin === "USDC");
  log("state", { address: wallet.address, equity: state.marginSummary.accountValue, withdrawable: state.withdrawable, spotUsdc: usdc ? String(Number(usdc.total) - Number(usdc.hold)) : "0",
    positions: state.assetPositions.map((a) => ({ coin: a.position.coin, szi: a.position.szi })) });
} else if (command === "flatten") {
  const state = await info.clearinghouseState({ user: wallet.address });
  for (const { position: p } of state.assetPositions) {
    if (Number(p.szi) !== 0) await trade(p.coin, { size: -Number(p.szi), reduceOnly: true, label: `flatten ${p.coin}` });
  }
  log("flat", await position("ETH"));
} else if (command === "send") {
  const [, destination, amount] = args;
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination ?? "") || !(Number(amount) > 0)) throw new Error("usage: send <address> <usdc>");
  const result = await exchange.usdSend({ destination: destination.toLowerCase(), amount: String(amount) });
  log("usdSend", { destination, amount, status: result.status });
} else if (command === "open" || command === "reduce" || command === "close") {
  const [, coin, amount] = args;
  if (!/^[A-Z0-9]{1,20}$/.test(coin ?? "")) throw new Error(`usage: ${command} <COIN> ${command === "close" ? "" : command === "open" ? "<usd>" : "<fraction>"}`);
  if (command === "open") { if (!(Math.abs(Number(amount)) >= 10)) throw new Error("open: at least 10 USD (the exchange minimum)"); await trade(coin, { usd: Number(amount), label: `open ${coin}` }); }
  else {
    const p = await position(coin), share = command === "close" ? 1 : Number(amount);
    if (!(share > 0 && share <= 1)) throw new Error("reduce: a fraction in (0, 1]");
    if (p.szi === 0) throw new Error(`leader holds no ${coin}`);
    await trade(coin, { size: -p.szi * share, reduceOnly: true, label: `${command} ${coin}` });
  }
  log("position", { coin, ...(await position(coin)) });
} else if (command === "refusable") {
  log("refusable", await refusable());
} else if (command === "scenario") {
  // Each leg is a separate leader order the copy must mirror; `gap` seconds
  // between legs so each is its own signal (no same-coin merging across legs).
  const name = args[1] && !args[1].startsWith("--") ? args[1] : "base";
  const coin = flag("coin", "ETH"), gap = Number(flag("gap", "20")) * 1000;
  const reduce = (c, share, label) => async () => { const p = await position(c); return trade(c, { size: -p.szi * share, reduceOnly: true, label }); };
  const odd = name === "refused-open" ? await refusable() : null;
  /** Scenario legs: [label, run, pause after (ms)]. */
  const SCENARIO_LEGS = {
    // open → add → reduce half → close → flip (short) → close.
    base: [
      ["open long", () => trade(coin, { usd: 60, label: "open long" })],
      ["add long", () => trade(coin, { usd: 30, label: "add long" })],
      ["reduce half", reduce(coin, 0.5, "reduce half")],
      ["close", reduce(coin, 1, "close")],
      ["open short", () => trade(coin, { usd: -60, label: "open short" })],
      ["flip to long", async () => { const p = await position(coin); return trade(coin, { size: -p.szi + 60 / (await market(coin)).mid, label: "flip to long" }); }],
      ["final close", reduce(coin, 1, "final close")],
    ],
    // (3) reduce 25 % of a 24 USD position: the follower's quarter is under the
    // 10 USD minimum (it closes all or the minimum); then the full close.
    "reduce-min": [
      ["open 24", () => trade(coin, { usd: 24, label: "open 24" })],
      ["reduce 25 %", reduce(coin, 0.25, "reduce 25 %")],
      ["full close", reduce(coin, 1, "full close")],
    ],
    // (9) open 36, then close it in 3 fills within 20 s.
    burst: [
      ["open 36", () => trade(coin, { usd: 36, label: "open 36" }), gap],
      ["close 1/3", reduce(coin, 1 / 3, "close 1/3"), 6000],
      ["close 1/2", reduce(coin, 1 / 2, "close 1/2"), 6000],
      ["close rest", reduce(coin, 1, "close rest")],
    ],
    // (8) an open the follower can't send (below_min_notional on `odd`),
    // then legs that must still execute, a close included.
    "refused-open": odd ? [
      ["open refusable", () => trade(odd.coin, { size: Math.max(2, Math.ceil(11 / odd.lotUsd)) / 10 ** odd.szDecimals, label: `open ${odd.coin} (follower refused)` })],
      ["open ETH", () => trade(coin, { usd: 20, label: `open ${coin}` })],
      ["close refusable", reduce(odd.coin, 1, `close ${odd.coin} (follower holds none)`)],
      ["close ETH", reduce(coin, 1, `close ${coin}`)],
    ] : [],
  };
  const steps = SCENARIO_LEGS[name];
  if (!steps) { console.error(`unknown scenario ${name} (${Object.keys(SCENARIO_LEGS).join(" | ")})`); process.exit(2); }
  const start = await position(coin);
  log("start", { address: wallet.address, scenario: name, coin, ...(odd ? { refusable: odd } : {}), ...start });
  if (start.szi !== 0 && !DRY) throw new Error(`leader already holds ${coin} ${start.szi}; close it first`);
  for (const [label, run, pause = gap] of steps) {
    if (DRY && /reduce|close/.test(label)) { log("trade_planned", { label, reduceOnly: true, note: "sized from the position at the time" }); continue; }
    await run(); if (!DRY) log("leg_done", { leg: label, position: await position(coin) }); if (!DRY) await sleep(pause);
  }
  log("done", DRY ? { dryRun: true } : await position(coin));
} else {
  console.error("usage: leader.mjs scenario [base|reduce-min|burst|refused-open]|open|reduce|close|refusable|send|state|flatten");
  process.exit(2);
}
