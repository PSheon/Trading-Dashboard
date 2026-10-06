import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/**
 * Server components never render `<Button>` (Paul, 2026-10-06): Button is a
 * client component with state (`loading`); a server component takes its
 * look from `buttonVariants` (button-variants.ts) on a link or a form
 * button. A file without the client directive is (or can be imported as) a
 * server component, so it may not import Button.
 */
const SRC = join(__dirname, "../src");
function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}
const isClient = (source: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*["']use client["']/.test(source);
const importsButton = (source: string) => /from\s+["'](?:@\/components\/ui\/button|\.\.?\/(?:ui\/)?button)["']/.test(source);

export function serverFilesWithButton(root = SRC): string[] {
  return files(root).filter((file) => {
    const source = readFileSync(file, "utf8");
    return !isClient(source) && importsButton(source) && !file.endsWith("/components/ui/button.tsx");
  }).map((file) => relative(root, file));
}

it("no server component imports Button (they use buttonVariants)", () => {
  expect(serverFilesWithButton()).toEqual([]);
});

it("the rule sees a server file that does (the check itself works)", () => {
  const fixture = join(__dirname, "fixtures/server-button");
  expect(serverFilesWithButton(fixture)).toEqual(["page.tsx"]);
});
