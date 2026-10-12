// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TraderCell } from "@/components/discover/trader-cell";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));

/** D4: the watchlist's trader cell (table, phone row, alerts list). */
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const render = (verified: boolean, subtitle?: ReactNode) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <I18nProvider locale="en" messages={catalogs.en}>
      <TraderCell trader={{ address: ADDRESS, avatarUrl: null, displayName: "Whale", verified }} size={40} subtitle={subtitle} />
    </I18nProvider>,
  );
  return host;
};

describe("TraderCell", () => {
  it("links the avatar and the name to the trader page; the avatar link is named by the trader", () => {
    const host = render(false, <p className="sub">2 alerts</p>);
    const links = host.querySelectorAll("a");
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute("href")).toBe(`/en/trader/${ADDRESS}`);
    expect(links[0]!.getAttribute("aria-label")).toBe("Whale");
    expect(links[1]!.textContent).toBe("Whale");
    expect(host.querySelector(".sub")!.textContent).toBe("2 alerts");
  });

  it("shows the verified tick only for a verified trader", () => {
    expect(render(false).querySelectorAll("a")[1]!.querySelector("svg")).toBeNull();
    expect(render(true).querySelectorAll("a")[1]!.querySelector("svg")).not.toBeNull();
  });
});
