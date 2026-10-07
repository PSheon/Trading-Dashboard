// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataList } from "../src/components/ui/data-list";
import { SortHead, useSorted } from "../src/components/ui/sort-head";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "../src/components/ui/table";
import { TablePager, usePaged } from "../src/components/ui/table-pager";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

/**
 * Workstream ⑪ (audit §九, B7): two table systems — `ui/Table` and one
 * `DataList` — with one `SortHead` and one `TablePager` (ten a page).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let el: HTMLDivElement;
beforeEach(() => { el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider>));

describe("DataList", () => {
  it("is a ul of dotted rows by default, marked as the shared list", async () => {
    await render(<DataList className="mt-3"><li>a</li><li>b</li></DataList>);
    const list = el.querySelector("[data-slot=data-list]")!;
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("data-variant")).toBe("rows");
    expect(list.className).toContain("divide-dotted");
    expect(list.className).toContain("divide-y-2");
    expect(list.className).toContain("mt-3");
  });

  it("renders as an ol or a dl, and as a column of cards", async () => {
    await render(<><DataList as="ol"><li>a</li></DataList><DataList as="dl"><div><dt>k</dt><dd>v</dd></div></DataList><DataList variant="cards"><li>c</li></DataList></>);
    const [ol, dl, cards] = el.querySelectorAll("[data-slot=data-list]");
    expect(ol.tagName).toBe("OL");
    expect(dl.tagName).toBe("DL");
    expect(cards.getAttribute("data-variant")).toBe("cards");
    expect(cards.className).not.toContain("divide-dotted");
    expect(cards.className).toContain("gap-2");
  });
});

type Row = { name: string; pnl: number };
const ROWS: Row[] = [{ name: "b", pnl: 2 }, { name: "a", pnl: 10 }, { name: "c", pnl: -1 }];
const KEYS = { name: (r: Row) => r.name, pnl: (r: Row) => r.pnl };

function Sorted() {
  const { sorted, sort, onSort } = useSorted<Row, "name" | "pnl">(ROWS, KEYS, { key: "pnl", dir: "desc" });
  return (
    <Table>
      <TableHeader><TableRow><SortHead label="Name" col="name" sort={sort} onSort={onSort} /><SortHead label="PnL" col="pnl" sort={sort} onSort={onSort} className="text-right" /></TableRow></TableHeader>
      <TableBody>{sorted.map((r) => <TableRow key={r.name}><TableCell>{r.name}</TableCell><TableCell>{r.pnl}</TableCell></TableRow>)}</TableBody>
    </Table>
  );
}
const names = () => [...el.querySelectorAll("tbody tr")].map((tr) => tr.firstElementChild!.textContent).join("");

describe("SortHead", () => {
  it("is a table head: aria-sort on every sortable column (none when unsorted), an arrow only on the sorted one", async () => {
    await render(<Sorted />);
    const [name, pnl] = el.querySelectorAll("th");
    expect(name.getAttribute("data-slot")).toBe("table-head");
    expect(name.getAttribute("aria-sort")).toBe("none");
    expect(pnl.getAttribute("aria-sort")).toBe("descending");
    expect(name.querySelector("svg")).toBeNull();
    expect(pnl.querySelector("svg")).not.toBeNull();
    expect(pnl.className).toContain("text-right");
    // The sorted column is marked by colour and the arrow, not by weight.
    expect(pnl.querySelector("button")!.className).toContain("text-foreground");
    expect(pnl.querySelector("button")!.className).not.toMatch(/font-(semibold|bold|extrabold)/);
    expect(names()).toBe("abc");
  });

  it("flips the sorted column and sorts a new one descending (text by locale order)", async () => {
    await render(<Sorted />);
    const [name, pnl] = el.querySelectorAll("th");
    await act(async () => pnl.querySelector("button")!.click());
    expect(pnl.getAttribute("aria-sort")).toBe("ascending");
    expect(names()).toBe("cba");
    await act(async () => name.querySelector("button")!.click());
    expect(name.getAttribute("aria-sort")).toBe("descending");
    expect(pnl.getAttribute("aria-sort")).toBe("none");
    expect(names()).toBe("cba");
    await act(async () => name.querySelector("button")!.click());
    expect(names()).toBe("abc");
  });
});

function Paged({ n }: { n: number }) {
  const { rows, pager } = usePaged(Array.from({ length: n }, (_, i) => i));
  return <><DataList>{rows.map((i) => <li key={i}>{i}</li>)}</DataList><TablePager {...pager} /></>;
}

describe("a DataList with the pager", () => {
  it("shows ten a page with 上一頁 / 第 n / m 頁 / 下一頁, and no pager while it fits", async () => {
    await render(<Paged n={10} />);
    expect(el.querySelectorAll("li")).toHaveLength(10);
    expect(el.querySelector("[data-pager]")).toBeNull();
    await render(<Paged n={23} />);
    expect(el.querySelectorAll("li")).toHaveLength(10);
    expect(el.querySelector("[data-pager]")!.textContent).toBe("上一頁第 1 / 3 頁下一頁");
    const next = el.querySelectorAll<HTMLButtonElement>("[data-pager] button")[1];
    await act(async () => next.click());
    await act(async () => next.click());
    expect([...el.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["20", "21", "22"]);
  });
});
