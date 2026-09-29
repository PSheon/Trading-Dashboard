import { readFileSync, writeFileSync } from "node:fs";
import { httpRouteContracts } from "../packages/shared/dist/wire-contracts.js";
const target = new URL("../docs/http-routes.md", import.meta.url);
const document = `# HTTP route contracts\n\nGenerated from packages/shared/src/wire-contracts.ts. Regenerate with \`node scripts/http-contract-docs.mjs\`; CI checks \`--check\`. See [HTTP boundary](http-contract.md) for negotiation, validation and errors.\n\n| Method | Path | Success status | Access |\n| --- | --- | --- | --- |\n${httpRouteContracts.map((r) => `| ${r.method} | \`${r.path}\` | ${r.status} | ${r.auth} |`).join("\n")}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== document) throw new Error("HTTP contract docs are stale");
} else writeFileSync(target, document);
