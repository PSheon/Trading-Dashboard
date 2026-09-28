// A small SVG chart drawn straight into a container: dots (optionally joined),
// linear or log y, time x, a legend for two or more series, and a hover
// tooltip on the nearest point.

export interface ChartPoint {
  x: number; // unix seconds
  y: number | null;
  tip?: string;
}

export interface ChartSeries {
  name: string;
  color: string; // a CSS color or var(--series-n)
  points: ChartPoint[];
  line?: boolean;
}

export interface ChartOptions {
  series: ChartSeries[];
  xFormat: (v: number, full: boolean, step: number) => string;
  yFormat: (v: number, full: boolean) => string;
  log?: boolean;
  height?: number;
  minStep?: number; // smallest x tick step in seconds
  empty?: string;
}

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
function div(className: string, text?: string) {
  const d = document.createElement("div");
  d.className = className;
  if (text) d.textContent = text;
  return d;
}

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

// Log ticks at 1, 2, 5 × 10^k, thinned to powers of ten when there are too many.
function logTicks(lo: number, hi: number, max = 8): number[] {
  const out: number[] = [];
  for (let k = Math.floor(lo); k <= Math.ceil(hi); k++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** k;
      if (Math.log10(v) >= lo && Math.log10(v) <= hi) out.push(v);
    }
  }
  if (out.length <= max) return out;
  const powers = out.filter((v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
  return powers.length > max ? powers.filter((_, i) => i % Math.ceil(powers.length / max) === 0) : powers;
}

// Time ticks on whole hours or days (UTC), about `n` of them.
const STEPS = [3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400, 90 * 86400];
function timeTicks(lo: number, hi: number, n: number, minStep: number) {
  const step = STEPS.find((s) => s >= minStep && (hi - lo) / s <= n) ?? STEPS.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return { ticks, step };
}

export function drawChart(container: HTMLElement, opts: ChartOptions): void {
  const { series, xFormat, yFormat, log = false, height = 260, minStep = 0, empty = "No data" } = opts;
  container.replaceChildren();
  container.classList.add("chart");
  const usable = (p: ChartPoint) => p.y != null && (!log || p.y > 0);
  const pts = series.flatMap((s) => s.points).filter(usable) as (ChartPoint & { y: number })[];
  if (!pts.length) {
    container.append(div("empty", empty));
    return;
  }
  if (series.length > 1) {
    const legend = div("legend");
    for (const s of series) {
      const item = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = s.color;
      item.append(dot, s.name);
      legend.append(item);
    }
    container.append(legend);
  }
  const width = container.clientWidth || 600;
  const m = { top: 8, right: 16, bottom: 26, left: 64 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  let x0 = Math.min(...pts.map((p) => p.x));
  let x1 = Math.max(...pts.map((p) => p.x));
  if (x0 === x1) [x0, x1] = [x0 - 86400, x1 + 86400];
  const tf = log ? Math.log10 : (v: number) => v;
  let y0 = tf(Math.min(...pts.map((p) => p.y)));
  let y1 = tf(Math.max(...pts.map((p) => p.y)));
  if (!log) [y0, y1] = [Math.min(y0, 0), Math.max(y1, 0)];
  const pad = (y1 - y0 || 1) * 0.06;
  y0 -= pad;
  y1 += pad;
  const X = (v: number) => m.left + ((v - x0) / (x1 - x0)) * w;
  const Y = (v: number) => m.top + h - ((tf(v) - y0) / (y1 - y0)) * h;

  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height });
  const grid = svg("g", { class: "grid" });
  const axis = svg("g", { class: "axis" });
  for (const t of log ? logTicks(y0, y1) : niceTicks(y0, y1, 4)) {
    const y = Y(t);
    if (y < m.top - 1 || y > m.top + h + 1) continue;
    grid.append(svg("line", { x1: m.left, x2: m.left + w, y1: y, y2: y }));
    const label = svg("text", { x: m.left - 8, y: y + 4, "text-anchor": "end" });
    label.textContent = yFormat(t, false);
    axis.append(label);
  }
  const { ticks, step } = timeTicks(x0, x1, Math.max(2, Math.floor(w / 110)), minStep);
  for (const t of ticks) {
    // Keep edge labels inside the plot.
    const anchor = X(t) > m.left + w - 36 ? "end" : X(t) < m.left + 36 ? "start" : "middle";
    const label = svg("text", { x: X(t), y: height - 6, "text-anchor": anchor });
    label.textContent = xFormat(t, false, step);
    axis.append(label);
  }
  root.append(grid, axis);

  const marks: { p: ChartPoint & { y: number }; s: ChartSeries; cx: number; cy: number }[] = [];
  for (const s of series) {
    const ps = (s.points.filter(usable) as (ChartPoint & { y: number })[]).sort((a, b) => a.x - b.x);
    if (s.line && ps.length > 1) {
      root.append(svg("path", {
        d: ps.map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`).join(""),
        fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round",
      }));
    }
    for (const p of ps) {
      root.append(svg("circle", {
        cx: X(p.x), cy: Y(p.y), r: s.line ? 3 : 4, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2,
      }));
      marks.push({ p, s, cx: X(p.x), cy: Y(p.y) });
    }
  }
  const ring = svg("circle", { r: 7, fill: "none", stroke: "var(--text-primary)", "stroke-width": 1.5, visibility: "hidden" });
  root.append(ring);
  const tip = div("tip");
  container.append(root, tip);

  root.addEventListener("mousemove", (ev) => {
    const r = root.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * width;
    const my = ((ev.clientY - r.top) / r.height) * height;
    let best: (typeof marks)[number] | null = null;
    let bestD = 28 ** 2;
    for (const mk of marks) {
      const d = (mk.cx - mx) ** 2 + (mk.cy - my) ** 2;
      if (d < bestD) [best, bestD] = [mk, d];
    }
    if (!best) {
      ring.setAttribute("visibility", "hidden");
      tip.style.display = "none";
      return;
    }
    ring.setAttribute("cx", String(best.cx));
    ring.setAttribute("cy", String(best.cy));
    ring.setAttribute("visibility", "visible");
    const head = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = best.s.name;
    head.append(name, ` · ${xFormat(best.p.x, true, step)}`);
    tip.replaceChildren(head, div("", yFormat(best.p.y, true)), ...(best.p.tip ? [div("secondary", best.p.tip)] : []));
    tip.style.display = "block";
    tip.style.left = `${Math.min((best.cx / width) * r.width + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${(best.cy / height) * r.height + 12}px`;
  });
  root.addEventListener("mouseleave", () => {
    ring.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  });
}
