import { DASH, ago, api, dur, el, int, links, num, pct, short, signClass, sol, time } from "./common.js";

const LOW_SAMPLE = 30;

// key, label, how to render, whether it is a metric (greyed on low samples)
const COLUMNS = [
  { key: "wallet", label: "Wallet", left: true, render: (r) =>
      el("span", {}, el("a", { href: `/wallet?address=${r.wallet}`, class: "mono" }, short(r.wallet)),
        " ", el("a", { href: links.gmgn(r.wallet), target: "_blank", class: "muted", title: "GMGN" }, "↗")) },
  { key: "discovered_via", label: "Source", left: true, render: (r) => r.discovered_via ?? DASH },
  { key: "first_seen_at", label: "First seen", render: (r) => time(r.first_seen_at) },
  { key: "trade_count", label: "Trades", metric: true, render: (r) => int(r.trade_count) },
  { key: "token_count", label: "Tokens", metric: true, render: (r) => int(r.token_count) },
  { key: "realized_pnl_sol", label: "PnL (SOL)", metric: true, cls: (r) => signClass(r.realized_pnl_sol),
    render: (r) => sol(r.realized_pnl_sol) },
  { key: "win_rate", label: "Win rate", metric: true, render: (r) => pct(r.win_rate) },
  { key: "pnl_concentration", label: "Top win share", metric: true, render: (r) => pct(r.pnl_concentration) },
  { key: "median_hold_seconds", label: "Median hold", metric: true, render: (r) => dur(r.median_hold_seconds) },
  { key: "median_entry_age_seconds", label: "Entry age", metric: true, render: (r) => dur(r.median_entry_age_seconds) },
  { key: "pre_graduation_ratio", label: "Pre-grad", metric: true, render: (r) => pct(r.pre_graduation_ratio) },
  { key: "tx_per_active_hour", label: "Tx / active h", metric: true, render: (r) => num(r.tx_per_active_hour, 1) },
  { key: "max_drawdown_sol", label: "Max DD (SOL)", metric: true, render: (r) => num(r.max_drawdown_sol) },
  { key: "fees_sol", label: "Fees (SOL)", metric: true, render: (r) => num(r.fees_sol) },
  { key: "unknown_cost_ratio", label: "Unknown cost", metric: true, render: (r) => pct(r.unknown_cost_ratio) },
  { key: "last_active_at", label: "Last active", render: (r) => ago(r.last_active_at) },
  { key: "note", label: "Note", left: true, sortable: false, render: noteInput },
];

const state = { rows: [], sort: { key: "realized_pnl_sol", dir: -1 } };
const $ = (id) => document.getElementById(id);

function noteInput(r) {
  const input = el("input", { class: "note", value: r.note ?? "", placeholder: "…" });
  input.addEventListener("change", async () => {
    input.classList.remove("saved", "failed");
    try {
      await api(`/api/wallets/${r.wallet}/note`, { method: "PUT", body: JSON.stringify({ note: input.value }) });
      r.note = input.value.trim();
      input.classList.add("saved");
    } catch (e) {
      input.classList.add("failed");
      input.title = e.message;
    }
  });
  return input;
}

function header() {
  $("head").replaceChildren(...COLUMNS.map((c) => {
    const sorted = state.sort.key === c.key;
    const th = el("th", {
      class: [c.left && "left", c.sortable !== false && "sortable", sorted && "sorted"].filter(Boolean).join(" "),
      "data-dir": sorted ? (state.sort.dir > 0 ? "▲" : "▼") : null,
    }, c.label);
    if (c.sortable !== false) {
      th.addEventListener("click", () => {
        state.sort = { key: c.key, dir: sorted ? -state.sort.dir : (c.left ? 1 : -1) };
        render();
      });
    }
    return th;
  }));
}

function visible() {
  const q = $("search").value.trim().toLowerCase();
  const via = $("via").value;
  const minTrades = Number($("min-trades").value) || 0;
  const activeDays = Number($("active").value) || 0;
  const cutoff = Date.now() / 1000 - activeDays * 86400;
  const { key, dir } = state.sort;
  return state.rows
    .filter((r) => !q || r.wallet.toLowerCase().includes(q) || (r.note ?? "").toLowerCase().includes(q))
    .filter((r) => !via || r.discovered_via === via)
    .filter((r) => (r.trade_count ?? 0) >= minTrades)
    .filter((r) => !activeDays || (r.last_active_at ?? 0) >= cutoff)
    .sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // missing values always last
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
}

function render() {
  header();
  const rows = visible();
  $("count").textContent = `${rows.length} of ${state.rows.length} wallets`;
  $("rows").replaceChildren(...rows.map((r) => el("tr",
    { class: (r.trade_count ?? 0) < LOW_SAMPLE ? "low-sample" : null },
    COLUMNS.map((c) => el("td", {
      class: [c.left && "left", c.metric && "metric", c.cls?.(r)].filter(Boolean).join(" "),
    }, c.render(r))),
  )));
  if (!state.rows.length) {
    $("rows").replaceChildren(el("tr", {}, el("td", { colspan: COLUMNS.length, class: "left muted" },
      "No wallets yet. Add some below, then run the daily job.")));
  }
}

async function load(asOf) {
  const data = await api(`/api/wallets${asOf ? `?as_of=${asOf}` : ""}`);
  state.rows = data.wallets;
  render();
}

async function loadDates() {
  const dates = await api("/api/dates");
  const select = $("as-of");
  select.replaceChildren(...(dates.length ? dates : [""]).map((d) => el("option", { value: d }, d || "no snapshots")));
}

async function refreshJob() {
  const s = await api("/api/jobs");
  const btn = $("run-job");
  btn.disabled = s.running;
  let text = s.running ? `Running since ${time(s.started_at)} UTC…`
    : s.finished_at ? `Last run ${ago(s.finished_at)}` : "";
  if (s.error) text += " · failed";
  if (s.next_scheduled_at) text += ` · next ${time(s.next_scheduled_at)} UTC`;
  $("job-status").textContent = text;
  $("job-status").classList.toggle("error", Boolean(s.error));
  $("job-status").title = s.error ?? (s.result ? JSON.stringify(s.result, null, 1) : "");
  return s;
}

$("run-job").addEventListener("click", async () => {
  try { await api("/api/jobs/daily", { method: "POST" }); } catch (e) { alert(e.message); }
  const poll = async () => {
    const s = await refreshJob();
    if (s.running) setTimeout(poll, 3000);
    else { await loadDates(); await load($("as-of").value); }
  };
  poll();
});

$("add-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const status = $("add-status");
  status.classList.remove("error");
  try {
    const res = await api("/api/wallets", {
      method: "POST",
      body: JSON.stringify({ addresses: $("add-addresses").value, via: $("add-via").value }),
    });
    status.textContent = `Added ${res.added.length}, already known ${res.already_known}. Run the daily job to fetch them.`;
    $("add-addresses").value = "";
    await load($("as-of").value);
  } catch (e) {
    status.textContent = e.message;
    status.classList.add("error");
  }
});

for (const id of ["search", "via", "min-trades", "active"]) $(id).addEventListener("input", render);
$("as-of").addEventListener("change", () => load($("as-of").value));

await loadDates();
await load($("as-of").value);
await refreshJob();
