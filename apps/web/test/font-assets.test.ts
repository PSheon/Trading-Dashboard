import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

it("builds the brand and lazy CJK fonts without requesting Google Fonts", () => {
  expect(read("src/app/[locale]/layout.tsx")).not.toContain("next/font/google");
  expect(read("src/components/shell/noto-font.ts")).not.toContain("next/font/google");
});

it("ships complete licensed font slices with verified bytes and local CSS references", () => {
  const manifest = JSON.parse(read("public/fonts/manifest.json")) as {
    assets: Array<{ family: string; path: string; sha256: string; bytes: number }>;
  };
  const files = new Set(manifest.assets.map(asset => asset.path));
  expect(new Set(manifest.assets.map(asset => asset.family))).toEqual(new Set(["Noto Sans TC", "Nunito", "Fredoka"]));
  expect(manifest.assets.length).toBeGreaterThan(100);
  for (const asset of manifest.assets) {
    expect(asset.path).toMatch(/^\/fonts\/[a-z-]+\/[a-f0-9]{64}\.woff2$/);
    const bytes = readFileSync(resolve(process.cwd(), "public" + asset.path));
    expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
  }
  for (const slug of ["noto-sans-tc", "nunito", "fredoka"]) {
    expect(read(`public/fonts/${slug}/OFL.txt`)).toContain("SIL OPEN FONT LICENSE");
  }
  for (const path of ["src/app/orbie-fonts.css", "src/components/shell/noto-font.css"]) {
    const css = read(path);
    expect(css).not.toMatch(/https?:\/\/|fonts\.gstatic|fonts\.googleapis/);
    for (const match of css.matchAll(/url\(([^)]+)\)/g)) expect(files.has(match[1])).toBe(true);
    expect(css).toContain("unicode-range:");
    expect(css).toContain("size-adjust:");
  }
  const cjk = read("src/components/shell/noto-font.css");
  expect(cjk).toContain("font-weight:500");
  expect(cjk).toContain("font-weight:700");
  expect(cjk).toContain("font-display:optional");
  expect(cjk).not.toContain("font-display:swap");
});
