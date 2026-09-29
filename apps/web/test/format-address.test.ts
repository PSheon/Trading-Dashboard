import { describe, expect, it } from "vitest";
import { splitAddress, traderName, truncateAddress } from "../src/lib/format";

const ADDRESS = "0x30afce2f6842bf183c7e3fe7162e279ff0b6393e";
const ellipses = (s: string) => [...s].filter((c) => c === "…").length;

describe("address truncation", () => {
  it("keeps 6 + 4 characters around exactly one ellipsis", () => {
    expect(truncateAddress(ADDRESS)).toBe("0x30af…393e");
    expect(truncateAddress(ADDRESS, 8, 6)).toBe("0x30afce…b6393e");
    expect(ellipses(truncateAddress(ADDRESS))).toBe(1);
  });

  it("never shortens twice (the old header showed \"0x30af……\")", () => {
    const once = truncateAddress(ADDRESS);
    expect(truncateAddress(once)).toBe(once);
    expect(truncateAddress(truncateAddress(once, 4, 2))).toBe(once);
    expect(ellipses(traderName({ address: once }))).toBe(1);
  });

  it("leaves short strings alone", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234");
    // 6 + 1 + 4 = 11 characters: shortening wouldn't save anything.
    expect(truncateAddress("0x123456789")).toBe("0x123456789");
    expect(truncateAddress("")).toBe("");
  });

  it("splits into a head that CSS may cut and a tail that always shows", () => {
    expect(splitAddress(ADDRESS)).toEqual({ head: "0x30af…", tail: "393e" });
    // The ellipsis ends the head, so a CSS-cut head ("0x30a…") plus the tail
    // still has exactly one.
    const { head, tail } = splitAddress(ADDRESS);
    expect(head.endsWith("…")).toBe(true);
    expect(tail.includes("…")).toBe(false);
    expect(splitAddress("0x1234")).toEqual({ head: "0x1234", tail: "" });
    expect(splitAddress(" 0x30af…393e ")).toEqual({ head: "0x30af…393e", tail: "" });
  });

  it("trader names prefer the display name, else the short address", () => {
    expect(traderName({ address: ADDRESS, displayName: "  MP05 " })).toBe("MP05");
    expect(traderName({ address: ADDRESS, displayName: "   " })).toBe("0x30af…393e");
    expect(traderName({ address: ADDRESS, displayName: null })).toBe("0x30af…393e");
  });
});
