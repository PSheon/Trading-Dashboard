import { DASH, api, chart, dur, el, int, links, num, pct, short, signClass, sol, time, tokens } from "./common.js";

const $ = (id) => document.getElementById(id);
const address = new URLSearchParams(location.search).get("address");
const LAMPORTS = 1e9;
const TRADE_PAGE = 300;

// SOL per token: plain decimals down to 0.01, scientific below, so a column lines up.
const price = (v) => (v >= 0.01 ? v.toPrecision(3) : v.toExponential(2));

const METRICS = {
  realized_pnl_sol: { label: "Realized PnL (SOL)", fmt: (v) => num(v) },
  win_rate: { label: "Win rate", fmt: pct },
  trade_count: { label: "Closed round trips", fmt: int },
  median_hold_seconds: { label: "Median hold", fmt: dur },
  max_drawdown_sol: { label: "Max drawdown (SOL)", fmt: (v) => num(v) },
  unknown_cost_ratio: { label: "Unknown cost share", fmt: pct },
  tx_per_active_hour: { label: "Tx per active hour", fmt: (v) => num(v, 1) },
};

function tiles(latest) {
  const t = (k, v, cls) => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: `v ${cls ?? ""}` }, v));
  if (!latest) return [t("Snapshot", "none yet")];
  return [
    t("Realized PnL (SOL)", sol(latest.realized_pnl_sol), signClass(latest.realized_pnl_sol)),
    t("Round trips", int(latest.trade_count)),
    t("Win rate", pct(latest.win_rate)),
    t("Median hold", dur(latest.median_hold_seconds)),
    t("Top win share", pct(latest.pnl_concentration)),
    t("Unknown cost", pct(latest.unknown_cost_ratio)),
    t("As of", latest.as_of_date),
  ];
}

function priceChart(trades, mint) {
  const pick = trades.filter((t) => t.mint === mint && t.price_sol != null);
  const point = (t) => ({
    x: t.block_time, y: t.price_sol,
    tip: `${tokens(t.token_amount_raw, t.decimals)} tokens for ${num(t.sol_lamports / LAMPORTS)} SOL`,
  });
  chart($("price-chart"), {
    series: [
      { name: "Buy", color: "var(--series-1)", points: pick.filter((t) => t.side === "buy").map(point) },
      { name: "Sell", color: "var(--series-2)", points: pick.filter((t) => t.side === "sell").map(point) },
    ],
    log: true,
    xFormat: (v, full, step) => full ? `${time(v)} UTC` : step >= 86400 ? time(v).slice(5, 10) : time(v).slice(5, 16),
    yFormat: price,
    empty: "No SOL-priced trades on this token",
  });
  $("mint-link").href = links.solscanToken(mint);
}

function metricChart(history, key) {
  const m = METRICS[key];
  chart($("metric-chart"), {
    series: [{
      name: m.label, color: "var(--series-1)", line: true,
      points: history.map((r) => ({ x: Date.parse(`${r.as_of_date}T00:00:00Z`) / 1000, y: r[key] })),
    }],
    xFormat: (v) => new Date(v * 1000).toISOString().slice(0, 10),
    minStep: 86400,
    yFormat: (v) => m.fmt(v),
    empty: "No snapshots yet",
  });
}

function positionRow(p) {
  const status = p.closed_at == null ? "open"
    : p.complete ? "complete"
    : p.has_transfer_out ? "transferred out" : "unknown cost";
  const pnl = p.realized_pnl_lamports == null ? null : p.realized_pnl_lamports / LAMPORTS;
  return el("tr", {},
    el("td", { class: "left" }, el("a", { href: links.solscanToken(p.mint), target: "_blank", class: "mono" }, short(p.mint))),
    el("td", {}, time(p.opened_at)),
    el("td", {}, p.closed_at == null ? DASH : time(p.closed_at)),
    el("td", {}, p.closed_at == null ? DASH : dur(p.closed_at - p.opened_at)),
    el("td", {}, num(p.cost_lamports / LAMPORTS)),
    el("td", {}, p.closed_at == null ? DASH : num(p.proceeds_lamports / LAMPORTS)),
    el("td", { class: signClass(pnl) }, sol(pnl)),
    el("td", { class: `left ${status === "complete" ? "" : "muted"}` }, status),
  );
}

function tradeRow(t) {
  return el("tr", {},
    el("td", { class: "left" }, time(t.block_time)),
    el("td", { class: "left" }, el("a", { href: links.solscanToken(t.mint), target: "_blank", class: "mono" }, short(t.mint))),
    el("td", { class: "left" }, t.side),
    el("td", {}, tokens(t.token_amount_raw, t.decimals)),
    el("td", {}, t.sol_lamports == null ? DASH : num(t.sol_lamports / LAMPORTS)),
    el("td", { class: t.price_confidence === "low" ? "muted" : "" },
      t.price_sol == null ? DASH : price(t.price_sol)),
    el("td", {}, num(t.fee_lamports / LAMPORTS, 5)),
    el("td", { class: "left" }, el("a", { href: links.solscanTx(t.tx_sig), target: "_blank", class: "mono" }, short(t.tx_sig))),
  );
}

async function main() {
  if (!address) { $("title").textContent = "No address given"; return; }
  document.title = `Wallet ${short(address)}`;
  $("title").textContent = address;
  $("links").replaceChildren(
    el("a", { href: links.solscanAccount(address), target: "_blank" }, "Solscan ↗"), " ",
    el("a", { href: links.gmgn(address), target: "_blank" }, "GMGN ↗"),
  );
  const d = await api(`/api/wallets/${address}`);
  $("discovered").textContent = `Found via ${d.wallet.discovered_via} · first seen ${time(d.wallet.first_seen_at)} UTC`;

  const note = $("note");
  note.value = d.note;
  note.addEventListener("change", async () => {
    try {
      await api(`/api/wallets/${address}/note`, { method: "PUT", body: JSON.stringify({ note: note.value }) });
      $("note-status").textContent = "Saved";
    } catch (e) {
      $("note-status").textContent = e.message;
    }
  });

  $("tiles").replaceChildren(...tiles(d.metrics.at(-1)));

  // Tokens ordered by how often this wallet traded them.
  const byMint = new Map();
  for (const t of d.trades) byMint.set(t.mint, (byMint.get(t.mint) ?? 0) + 1);
  const mints = [...byMint.entries()].sort((a, b) => b[1] - a[1]);
  $("mint").replaceChildren(...mints.map(([m, n]) => el("option", { value: m }, `${short(m)} · ${n} trades`)));
  $("mint").addEventListener("change", () => priceChart(d.trades, $("mint").value));
  if (mints.length) priceChart(d.trades, mints[0][0]);
  else priceChart([], null);

  $("metric").replaceChildren(...Object.entries(METRICS).map(([k, m]) => el("option", { value: k }, m.label)));
  $("metric").addEventListener("change", () => metricChart(d.metrics, $("metric").value));
  metricChart(d.metrics, "realized_pnl_sol");

  $("pos-count").textContent = `(${int(d.positions.length)})`;
  $("positions").replaceChildren(...d.positions.map(positionRow));

  $("trade-count").textContent = `(${int(d.trades.length)})`;
  const showTrades = (n) => $("trades").replaceChildren(...d.trades.slice(0, n).map(tradeRow));
  showTrades(TRADE_PAGE);
  if (d.trades.length > TRADE_PAGE) {
    const more = $("more-trades");
    more.style.display = "";
    more.textContent = `Show all ${d.trades.length}`;
    more.addEventListener("click", () => { showTrades(d.trades.length); more.style.display = "none"; });
  }
}

main().catch((e) => {
  $("title").textContent = e.message;
});
