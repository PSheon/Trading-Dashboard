// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TableExpansionRow } from "@/components/ui/table";

/** D4: the details row under a data row (copies, orders, actions, admin audit and exposure). */
describe("TableExpansionRow", () => {
  it("is a bare row with one unpadded cell across every column", () => {
    const host = document.createElement("tbody");
    host.innerHTML = renderToStaticMarkup(
      <TableExpansionRow id="copy-user-1" colSpan={6}>
        <div className="row-expansion">details</div>
      </TableExpansionRow>,
    );
    const row = host.querySelector("tr")!;
    expect(row.id).toBe("copy-user-1");
    expect(row.getAttribute("data-slot")).toBeNull();
    expect(row.cells).toHaveLength(1);
    const cell = row.cells[0]!;
    expect(cell.colSpan).toBe(6);
    expect(cell.className).toBe("p-0");
    expect(cell.innerHTML).toBe('<div class="row-expansion">details</div>');
  });
});
