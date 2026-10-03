/** Explicit, read-only network smoke. Build shared first; no tokens or fixtures. */
import { writeFile } from "node:fs/promises";
import { httpRouteContracts } from "../packages/shared/dist/wire-contracts.js";
import { errorEnvelopeSchema, successEnvelopeSchema } from "../packages/shared/dist/http-contract.js";

const includeStage = process.argv.includes("--stage");
const retryBusy = process.argv.includes("--retry-busy");
const destinations = [{ site: "local", base: "http://127.0.0.1:3100" }];
if (includeStage) destinations.push({ site: "stage", base: "https://stage.orbie.fun/api/hl" });
const results = [];

async function probe(site, base, template, path = template) {
  const start = Date.now();
  const result = { site, route: template };
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    result.status = response.status;
    const payload = await response.json();
    const contract = httpRouteContracts.find((entry) => entry.method === "GET" && entry.path === template);
    if (!contract) throw new Error("Missing route contract");
    if (!response.ok) {
      const failure = errorEnvelopeSchema.safeParse(payload);
      result.envelopeValid = failure.success && failure.data.statusCode === response.status;
      result.contractValid = false;
      if (failure.success) result.errorCode = failure.data.error.code;
      result.retryAfter = response.headers.get("retry-after");
      result.ms = Date.now() - start;
      results.push(result);
      return undefined;
    }
    const envelope = contract.raw ? null : successEnvelopeSchema.safeParse(payload);
    result.envelopeValid = contract.raw || (envelope.success && envelope.data.statusCode === response.status);
    const data = contract.raw ? payload : envelope.success ? envelope.data.data : undefined;
    const parsed = contract.response.safeParse(data);
    result.contractValid = response.ok && result.envelopeValid && parsed.success;
    if (parsed.success) {
      if (Array.isArray(data)) result.items = data.length;
      else if (Array.isArray(data.items)) result.items = data.items.length;
      if (template === "/health") result.feedConnected = data.feedConnected;
    }
    result.retryAfter = response.headers.get("retry-after");
    result.ms = Date.now() - start;
    results.push(result);
    return result.contractValid ? parsed.data : undefined;
  } catch (error) {
    result.error = error.name;
    result.ms = Date.now() - start;
    results.push(result);
    return undefined;
  }
}

async function read(site, base, template, path = template) {
  let data;
  for (let attempt = 1; attempt <= (retryBusy ? 3 : 1); attempt++) {
    data = await probe(site, base, template, path);
    const result = results.at(-1);
    result.attempt = attempt;
    if (result.status !== 503 || !result.envelopeValid || result.errorCode !== "busy" || attempt === 3 || !retryBusy) break;
    const seconds = Number(result.retryAfter);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) break;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
  }
  return data;
}

for (const { site, base } of destinations) {
  await read(site, base, "/health");
  const list = await read(site, base, "/traders", "/traders?limit=5");
  const address = list?.items[0]?.address;
  if (!address) {
    results.push({ site, route: "/traders/:address", error: "NoPublicTraderAvailable" });
    continue;
  }
  for (const suffix of ["", "/portfolio", "/activity", "/fills", "/orders", "/twap", "/transfers"]) {
    await read(site, base, "/traders/:address" + suffix, "/traders/" + encodeURIComponent(address) + suffix);
  }
}
const finalResults = [...new Map(results.map((result) => [result.site + result.route, result])).values()];
const report = { at: new Date().toISOString(), retryBusy, results };
console.log(JSON.stringify(report, null, 2));
if (process.env.NETWORK_SUMMARY_FILE) await writeFile(process.env.NETWORK_SUMMARY_FILE, JSON.stringify(report, null, 2), { mode: 0o600 });
if (finalResults.some((result) => !result.contractValid || result.feedConnected === false)) process.exitCode = 1;
