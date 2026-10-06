#!/usr/bin/env node
// Copy harness — the controlled leader (testnet only).
//
// A wallet we own places a fixed scenario of market-like IOC orders on
// Hyperliquid testnet, so a copy of it can be checked deterministically
// (scripts/copy-harness/reconcile.mjs) instead of waiting for real traders.
//
// Key: HARNESS_LEADER_PRIVATE_KEY from .env.harness-leader.testnet.local
// (gitignored, 0600); never printed. Run from apps/api (it uses its deps):
//   node ../../scripts/copy-harness/leader.mjs scenario [--coin ETH] [--gap 20]
//   node ../../scripts/copy-harness/leader.mjs send <address> <usdc>
//   node ../../scripts/copy-harness/leader.mjs state
//   node ../../scripts/copy-harness/leader.mjs flatten   (closes whatever it holds: a rerun after an aborted scenario)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Dependencies resolve from apps/api (this script has no package of its own).
const apiRequire = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const load = (name) => import(pathToFileURL(apiRequire.resolve(name)).href);
const { ExchangeClient, HttpTransport, InfoClient } = await load("@nktkas/hyperliquid");
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
} else if (command === "scenario") {
  // open → add → reduce half → close → flip (short) → close. Each leg is a
  // separate leader order the copy must mirror; `gap` seconds between legs
  // so each is its own signal (no same-coin merging across legs).
  const coin = flag("coin", "ETH"), gap = Number(flag("gap", "20")) * 1000;
  const start = await position(coin);
  log("start", { address: wallet.address, coin, ...start });
  if (start.szi !== 0) throw new Error(`leader already holds ${coin} ${start.szi}; close it first`);
  const steps = [
    ["open long", () => trade(coin, { usd: 60, label: "open long" })],
    ["add long", () => trade(coin, { usd: 30, label: "add long" })],
    ["reduce half", async () => { const p = await position(coin); return trade(coin, { size: -p.szi / 2, reduceOnly: true, label: "reduce half" }); }],
    ["close", async () => { const p = await position(coin); return trade(coin, { size: -p.szi, reduceOnly: true, label: "close" }); }],
    ["open short", () => trade(coin, { usd: -60, label: "open short" })],
    ["flip to long", async () => { const p = await position(coin); return trade(coin, { size: -p.szi + 60 / (await market(coin)).mid, label: "flip to long" }); }],
    ["final close", async () => { const p = await position(coin); return trade(coin, { size: -p.szi, reduceOnly: true, label: "final close" }); }],
  ];
  for (const [name, run] of steps) { await run(); log("leg_done", { leg: name, position: await position(coin) }); await sleep(gap); }
  log("done", await position(coin));
} else {
  console.error("usage: leader.mjs scenario|send|state|flatten");
  process.exit(2);
}
