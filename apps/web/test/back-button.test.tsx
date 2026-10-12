// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackButton } from "@/components/ui/back-button";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));

/** D4: the round back control, shared by the trader page and a copy's detail. */
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const SHAPE = "orbit-press relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring";

describe("BackButton", () => {
  it("is a labelled link to the route under the current locale when given href", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" messages={catalogs.en}><BackButton href="/explore" label="Back" /></I18nProvider>);
    const host = document.createElement("div"); host.innerHTML = html;
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/en/explore");
    expect(link.getAttribute("aria-label")).toBe("Back");
    expect(link.className).toBe(SHAPE);
    expect(link.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(link.querySelector("svg")!.getAttribute("stroke-width")).toBe("2.4");
  });

  it("is a labelled button that calls onClick otherwise", async () => {
    const onClick = vi.fn();
    await act(async () => root.render(<BackButton onClick={onClick} label="Back to copies" />));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Back to copies");
    expect(button.className).toBe(SHAPE);
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
