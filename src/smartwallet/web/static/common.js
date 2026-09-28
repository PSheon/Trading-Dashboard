// Shared helpers: API calls, number formatting, a small SVG chart.

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch {}
    throw new Error(`${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return res.json();
}

export const DASH = "–";

export function sol(v, digits = 3) {
  if (v == null) return DASH;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}
export function num(v, digits = 3) {
  return v == null ? DASH : v.toFixed(digits);
}
export function pct(v) {
  return v == null ? DASH : `${(v * 100).toFixed(1)}%`;
}
export function int(v) {
  return v == null ? DASH : v.toLocaleString("en-US");
}
export function dur(s) {
  if (s == null) return DASH;
  const a = Math.abs(s);
  if (a < 60) return `${Math.round(s)}s`;
  if (a < 3600) return `${(s / 60).toFixed(1)}m`;
  if (a < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
export function time(ts) {
  if (ts == null) return DASH;
  return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
}
export function ago(ts) {
  if (ts == null) return DASH;
  const s = Date.now() / 1000 - ts;
  return s < 0 ? time(ts) : `${dur(s)} ago`;
}
export function short(addr) {
  return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : DASH;
}
export function compact(v) {
  if (v == null) return DASH;
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}
export function tokens(raw, decimals) {
  return raw == null ? DASH : compact(raw / 10 ** (decimals ?? 0));
}
export function signClass(v) {
  return v == null || v === 0 ? "" : v > 0 ? "pos" : "neg";
}
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const links = {
  solscanAccount: (a) => `https://solscan.io/account/${a}`,
  solscanToken: (m) => `https://solscan.io/token/${m}`,
  solscanTx: (s) => `https://solscan.io/tx/${s}`,
  gmgn: (a) => `https://gmgn.ai/sol/address/${a}`,
};

// ---- chart -------------------------------------------------------------
// series: [{name, color: "var(--series-1)", points: [{x, y, tip}], line: bool}]
// Hover finds the nearest point in screen space; the tooltip carries the values.

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function niceTicks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

// Log ticks at 1, 2, 5 × 10^k, thinned to powers of ten when there are too many.
function logTicks(lo, hi, max = 8) {
  const out = [];
  for (let k = Math.floor(lo); k <= Math.ceil(hi); k++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** k;
      if (Math.log10(v) >= lo && Math.log10(v) <= hi) out.push(v);
    }
  }
  if (out.length <= max) return out;
  const powers = out.filter((v) => Number.isInteger(Math.log10(v)) || Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
  return powers.length > max ? powers.filter((_, i) => i % Math.ceil(powers.length / max) === 0) : powers;
}

// Time ticks on whole hours or days (UTC), about `n` of them.
const STEPS = [3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400, 90 * 86400];
function timeTicks(lo, hi, n, minStep = 0) {
  const step = STEPS.find((s) => s >= minStep && (hi - lo) / s <= n) ?? STEPS.at(-1);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return { ticks: out, step };
}

export function chart(container, { series, xFormat, yFormat, log = false, height = 260, minStep = 0, empty = "No data" }) {
  const draw = () => {
    container.replaceChildren();
    container.classList.add("chart");
    const pts = series.flatMap((s) => s.points).filter((p) => p.y != null && (!log || p.y > 0));
    if (!pts.length) {
      container.append(el("div", { class: "empty" }, empty));
      return;
    }
    if (series.length > 1) {
      container.append(el("div", { class: "legend" },
        series.map((s) => el("span", {}, el("i", { style: `background:${s.color}` }), s.name))));
    }
    const width = container.clientWidth || 600;
    const m = { top: 8, right: 16, bottom: 26, left: 64 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    if (x0 === x1) { x0 -= 86400; x1 += 86400; }
    const tf = log ? Math.log10 : (v) => v;
    let [y0, y1] = [tf(Math.min(...ys)), tf(Math.max(...ys))];
    if (!log) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    const pad = (y1 - y0 || 1) * 0.06;
    y0 -= pad; y1 += pad;
    const X = (v) => m.left + ((v - x0) / (x1 - x0)) * w;
    const Y = (v) => m.top + h - ((tf(v) - y0) / (y1 - y0)) * h;

    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height });
    const grid = svg("g", { class: "grid" });
    const axis = svg("g", { class: "axis" });
    const yTicks = log ? logTicks(y0, y1) : niceTicks(y0, y1, 4);
    for (const t of yTicks) {
      const y = Y(t);
      if (y < m.top - 1 || y > m.top + h + 1) continue;
      grid.append(svg("line", { x1: m.left, x2: m.left + w, y1: y, y2: y }));
      const label = svg("text", { x: m.left - 8, y: y + 4, "text-anchor": "end" });
      label.textContent = yFormat(t);
      axis.append(label);
    }
    const { ticks: xTicks, step } = timeTicks(x0, x1, Math.max(2, Math.floor(w / 110)), minStep);
    for (const t of xTicks) {
      // Keep edge labels inside the plot.
      const anchor = X(t) > m.left + w - 36 ? "end" : X(t) < m.left + 36 ? "start" : "middle";
      const label = svg("text", { x: X(t), y: height - 6, "text-anchor": anchor });
      label.textContent = xFormat(t, false, step);
      axis.append(label);
    }
    root.append(grid, axis);

    const marks = [];
    for (const s of series) {
      const ps = s.points.filter((p) => p.y != null && (!log || p.y > 0)).sort((a, b) => a.x - b.x);
      if (s.line && ps.length > 1) {
        root.append(svg("path", {
          d: ps.map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`).join(""),
          fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round",
        }));
      }
      for (const p of ps) {
        const c = svg("circle", {
          cx: X(p.x), cy: Y(p.y), r: s.line ? 3 : 4, fill: s.color,
          stroke: "var(--surface-1)", "stroke-width": 2,
        });
        root.append(c);
        marks.push({ c, p, s, cx: X(p.x), cy: Y(p.y) });
      }
    }
    const ring = svg("circle", { r: 7, fill: "none", stroke: "var(--text-primary)", "stroke-width": 1.5, visibility: "hidden" });
    root.append(ring);
    const tip = el("div", { class: "tip" });
    container.append(root, tip);

    root.addEventListener("mousemove", (ev) => {
      const r = root.getBoundingClientRect();
      const mx = ((ev.clientX - r.left) / r.width) * width;
      const my = ((ev.clientY - r.top) / r.height) * height;
      let best = null, bestD = 28 ** 2;
      for (const mk of marks) {
        const d = (mk.cx - mx) ** 2 + (mk.cy - my) ** 2;
        if (d < bestD) { best = mk; bestD = d; }
      }
      if (!best) { ring.setAttribute("visibility", "hidden"); tip.style.display = "none"; return; }
      ring.setAttribute("cx", best.cx); ring.setAttribute("cy", best.cy);
      ring.setAttribute("visibility", "visible");
      tip.replaceChildren(
        el("div", {}, el("strong", {}, best.s.name), " · ", xFormat(best.p.x, true)),
        el("div", {}, yFormat(best.p.y, true)),
        best.p.tip ? el("div", { class: "secondary" }, best.p.tip) : null,
      );
      tip.style.display = "block";
      const left = (best.cx / width) * r.width;
      tip.style.left = `${Math.min(left + 12, r.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${(best.cy / height) * r.height + 12}px`;
    });
    root.addEventListener("mouseleave", () => {
      ring.setAttribute("visibility", "hidden");
      tip.style.display = "none";
    });
  };
  draw();
  let last = container.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - last) > 4) { last = container.clientWidth; draw(); }
  }).observe(container);
}
