// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import { MarketsTable, WalletsTable, WalletsTableSkeleton } from "@/components/insights/cohort-tables";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { fixtureCohort } from "@/fixtures/discovery";

vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

let root: Root, el: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const render = (node: ReactNode) => act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}>{node}</I18nProvider>));
const classes = (node: Element) => (node.getAttribute("class") ?? "").split(/\s+/);

/** The cohort tables' old private look: 13px/500 subtle headers, 12px cell padding. */
const OVERRIDES = ["px-3", "py-3", "text-[0.8125rem]", "font-medium", "text-subtle-foreground"];

describe("cohort tables use the shared Table's header and cells", () => {
  const cohort = fixtureCohort("profit");
  it.each([
    ["wallets", () => <WalletsTable rows={cohort.wallets} />],
    ["markets", () => <MarketsTable rows={cohort.markets} filter="all" />],
    ["wallets skeleton", () => <WalletsTableSkeleton rows={2} />],
  ] as const)("%s", async (_, node) => {
    await render(node());
    const cells = [...el.querySelectorAll("table th, table td")];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) for (const c of OVERRIDES) expect(classes(cell), `${cell.tagName} ${cell.textContent}`).not.toContain(c);
    // Functional pieces stay: fixed column widths and the 640px scroll box.
    const table = el.querySelector("table")!;
    expect(table.className).toMatch(/\bcd-cohort-(wallets|markets)\b/);
  });
  it("keeps the wallets' sticky header inside the 640px scroll box", async () => {
    await render(<WalletsTable rows={cohort.wallets} />);
    expect(el.querySelector('[data-slot="table-container"]')!.className).toContain("max-h-[640px]");
    expect(el.querySelector("thead")!.className).toContain("sticky");
  });
});

describe("TableSkeleton renders through the Table primitive", () => {
  it("uses the primitive's container, table and body, not a copy", async () => {
    await render(<TableSkeleton rows={2} columns={[{ label: "A" }, { label: "B", right: true }]} tableClassName="text-xs" />);
    const container = el.querySelector('[data-slot="table-container"]')!;
    expect(container).not.toBeNull();
    expect(container.classList.contains("table-dense")).toBe(false);
    const table = container.querySelector('table[data-slot="table"]')!;
    expect(table.className).toContain("text-xs");
    expect(table.querySelector('tbody[data-slot="table-body"]')!.classList.contains("data-rows")).toBe(true);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    // The copy is aria-hidden: its scroll box must not take focus.
    expect(container.hasAttribute("tabindex")).toBe(false);
    expect(el.querySelector('[aria-hidden="true"]')!.contains(container)).toBe(true);
  });
  it("passes dense to the primitive", async () => {
    await render(<TableSkeleton dense rows={1} columns={[{ label: "A" }]} />);
    expect(el.querySelector('[data-slot="table-container"]')!.classList.contains("table-dense")).toBe(true);
  });
});

/** `.cd-tables` (trader tabs, paper orders) holds only what differs from
 * `Table dense` + `.table-dense`; the cascade still yields 60px rows, 6px
 * gaps, 12px/700 headers and 18px row ends. */
describe(".cd-tables only adds to Table + .table-dense", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
    sel: sel.replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    decls: body.split(";").map((d) => d.trim()).filter(Boolean),
  }));
  const cd = rules.filter((r) => r.sel.includes(".cd-tables"));
  const all = cd.flatMap((r) => r.decls.map((d) => d.split(":")[0].trim()));
  it("drops declarations the primitive already makes", () => {
    for (const p of ["border-collapse", "border-spacing", "font-weight", "font-family", "color", "font"]) expect(all).not.toContain(p);
    expect(cd.flatMap((r) => r.decls)).not.toContain("height: 60px");
    expect(cd.flatMap((r) => r.decls)).not.toContain("font-size: 12px");
  });
  it("keeps the 18px row ends after .table-dense's 14px so they win", () => {
    const ends = css.indexOf(".cd-tables th:first-child");
    expect(ends).toBeGreaterThan(css.indexOf(".table-dense th:first-child"));
    expect(css.slice(ends, css.indexOf("}", ends))).toContain("padding-left: 18px");
    expect(css).toMatch(/\.cd-tables td\.row-action\s*\{[^}]*width: 1px/);
  });
  it("the primitive still gives the rows, gaps and headers .cd-tables dropped", () => {
    expect(css).toMatch(/\.table-dense th\s*\{\s*font-size: 12px;/);
    const src = readFileSync(resolve(process.cwd(), "src/components/ui/table.tsx"), "utf8");
    expect(src).toContain("border-spacing-y-1.5");
    expect(src).toContain("h-[60px]");
    expect(src).toMatch(/text-xs font-bold[^"]*text-muted-foreground/);
  });
});
