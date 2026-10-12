// @vitest-environment happy-dom
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SearchInput } from "@/components/ui/search-input";

/** D4: the admin search field (users, copy exposure, trader diagnosis). */
const render = (el: ReactElement) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(el);
  return { wrapper: host.firstElementChild as HTMLElement, input: host.querySelector("input")!, icon: host.querySelector("svg")! };
};

describe("SearchInput", () => {
  it("is a named input with a decorative magnifier; the wrapper takes the width", () => {
    const { wrapper, input, icon } = render(<SearchInput className="w-full sm:w-64" type="search" aria-label="Search users" placeholder="Search users" defaultValue="" />);
    expect(wrapper.className).toBe("relative w-full sm:w-64");
    expect(input.getAttribute("aria-label")).toBe("Search users");
    expect(input.getAttribute("type")).toBe("search");
    expect(input.getAttribute("placeholder")).toBe("Search users");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("class")).toContain("pointer-events-none");
  });

  it("each size keeps its own height, padding, weight and icon", () => {
    expect(render(<SearchInput aria-label="q" />).input.className).toBe(
      "w-full rounded-full border-2 border-transparent bg-raised text-[15px] outline-none placeholder:text-subtle-foreground focus-visible:border-primary h-11 pr-4 pl-10 font-bold",
    );
    expect(render(<SearchInput size="lg" aria-label="q" />).input.className).toContain("h-12 pr-4 pl-11 font-bold");
    const xl = render(<SearchInput size="xl" aria-label="q" />);
    expect(xl.input.className).toContain("h-[52px] pr-5 pl-12 font-extrabold placeholder:font-bold");
    expect(xl.icon.getAttribute("class")).toContain("left-5 size-[18px]");
  });
});
