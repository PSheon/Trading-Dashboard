import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildOfflineOpenApi } from "../apps/api/scripts/openapi.mjs";

export const buildOpenApi = buildOfflineOpenApi;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL("../docs/openapi.json", import.meta.url);
  const document = JSON.stringify(await buildOpenApi(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== document) throw new Error("OpenAPI contracts are stale");
  } else writeFileSync(target, document);
}
