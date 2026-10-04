import { describe, expect, it } from "vitest";

import { THEME_COLOR, parseThemeChoice, themeClass } from "../src/lib/theme";

describe("theme choice", () => {
  it("reads only light or dark from the cookie; anything else follows the system", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
    for (const value of [undefined, null, "", "system", "DARK", "blue"]) expect(parseThemeChoice(value)).toBe("system");
  });

  it("puts a class on <html> only for an explicit choice", () => {
    expect(themeClass("system")).toBe("");
    expect(themeClass("light")).toBe("light");
    expect(themeClass("dark")).toBe("dark");
  });

  it("gives the browser chrome the page ground of each theme", () => {
    expect(THEME_COLOR).toEqual({ light: "#fbf6ee", dark: "#15132b" });
  });
});
