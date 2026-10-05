import { describe, expect, it } from "vitest";

import { SKELETON_IDS } from "../src/components/dev/skeleton-ids";
import { galleryFraming } from "../src/proxy";
import { contentSecurityPolicy } from "../src/lib/csp";

describe("the skeleton gallery", () => {
  it("lists the same items for the frame route as the gallery shows", async () => {
    const { SKELETON_ITEMS } = await import("../src/components/dev/skeleton-items");
    expect(SKELETON_ITEMS.map((item) => item.id)).toEqual([...SKELETON_IDS]);
  });

  it("is the only page that frames this origin, and its frames the only pages framed", () => {
    expect(galleryFraming("/zh-TW/dev/skeletons")).toBe("gallery");
    expect(galleryFraming("/en/dev/skeletons/home")).toBe("framed");
    for (const path of ["/zh-TW", "/en/explore", "/en/dev", "/en/dev/skeletons/home/x"]) expect(galleryFraming(path), path).toBeUndefined();
    const csp = (framing?: "gallery" | "framed") => contentSecurityPolicy({ nonce: "n", dev: false, framing });
    expect(csp()).toContain("frame-ancestors 'none'");
    expect(csp()).not.toMatch(/frame-src 'self'/);
    expect(csp("gallery")).toMatch(/frame-src 'self'/);
    expect(csp("gallery")).toContain("frame-ancestors 'none'");
    expect(csp("framed")).toContain("frame-ancestors 'self'");
  });
});
