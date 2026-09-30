import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const sourceRoot = new URL("../src/", import.meta.url);
const services = readdirSync(sourceRoot, { recursive: true })
  .filter((file): file is string => typeof file === "string" && file.endsWith(".service.ts"))
  .sort();

it.each(services)("%s keeps persistence behind repositories", (file) => {
  const source = readFileSync(new URL(file, sourceRoot), "utf8");
  expect(source).not.toMatch(/DRIZZLE_CLIENT|from ["']drizzle-orm|from ["']@trading-dashboard\/shared\/database/);
  expect(source).not.toMatch(/\b(?:this\.db|tx)\.(?:select|insert|update|delete|execute|transaction)\(/);
});
