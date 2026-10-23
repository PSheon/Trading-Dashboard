import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildQuery, checkIcon, evaluate, render } from "./site-freshness.mjs";
import { readOnlyScript } from "./ops-db.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const hours = (n) => new Date(NOW - n * 60 * 60 * 1000).toISOString();
const ICON_OK = { url: "https://web.example/api/coin-icon/BTC", status: 200, content_type: "image/svg+xml", ok: true };
const report = (cards, stalePortfolio, staleTrades, missingTrades = 0) => ({
  queried_at: hours(0), now: hours(0), cards, stale_portfolio: stalePortfolio, stale_trades: staleTrades, missing_trades_at: missingTrades,
  oldest_portfolio_at: hours(30), newest_portfolio_at: hours(1), pool_without_figures: 3, leaderboard_imported_at: hours(2), leaderboard_as_of: hours(2),
});

test("PASS under 10% stale with the icon answering 200", () => {
  const r = evaluate(report(200, 19, 10), ICON_OK);
  assert.equal(r.verdict, "PASS");
  assert.equal(r.stale_share.worst, 0.095);
  assert.match(render(r), /^PASS$/m);
});

test("FAIL at 10% stale on either stamp", () => {
  assert.equal(evaluate(report(200, 20, 0), ICON_OK).verdict, "FAIL");
  const r = evaluate(report(200, 0, 25), ICON_OK);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.stale_share.trades_at, 0.125);
  assert.match(r.reasons[0], /^stale cards 12\.5%/);
});

test("FAIL when the icon is unchecked or not 200 image/svg+xml", () => {
  assert.deepEqual(evaluate(report(100, 0, 0), null).reasons, ["coin icon route not checked (pass --base-url https://<web>)"]);
  const r = evaluate(report(100, 0, 0), { ...ICON_OK, status: 204, content_type: null, ok: false });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.reasons[0], /answered 204/);
  assert.equal(evaluate(report(0, 0, 0), ICON_OK).reasons[0], "no trader card has figures (discovery pool empty or never computed)");
});

test("checkIcon reads the status and the content type", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, redirect: init.redirect }); return { status: 200, headers: new Headers({ "content-type": "image/svg+xml; charset=utf-8" }) }; };
  const ok = await checkIcon("https://web.example/", fetchImpl);
  assert.deepEqual(seen, [{ url: "https://web.example/api/coin-icon/BTC", redirect: "manual" }]);
  assert.equal(ok.ok, true);
  const html = await checkIcon("https://web.example", async () => ({ status: 200, headers: new Headers({ "content-type": "text/html" }) }));
  assert.equal(html.ok, false);
  const down = await checkIcon("https://web.example", async () => { throw new TypeError("fetch failed"); });
  assert.equal(down.status, null);
  assert.match(down.error, /fetch failed/);
});

test("--sql-only renders the read-only statement", () => {
  const { text, params } = buildQuery(NOW);
  const script = readOnlyScript(text, params);
  assert.ok(script.startsWith("BEGIN READ ONLY;\n") && script.endsWith(";\nROLLBACK;\n"));
  assert.ok(script.includes("'2026-11-10T12:00:00.000Z'::timestamptz - interval '24 hours'"));
  assert.ok(!/\$\d/.test(script));
});

// Against a migrated scratch database (scripts/test-database.mjs), with a few
// pool rows written by the test itself before the read-only statement runs.
// Skipped without TEST_DATABASE_ADMIN_URL.
test("the statement counts stale cards on the real schema", { skip: !process.env.TEST_DATABASE_ADMIN_URL && "TEST_DATABASE_ADMIN_URL unset" }, async () => {
  const { withTestDatabase } = await import("../test-database.mjs");
  const { readOnlyQuery } = await import("./ops-db.mjs");
  const { Client } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("pg");
  await withTestDatabase(async (url) => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const rows = [
        ["0x" + "a".repeat(40), hours(1), hours(1)],      // fresh
        ["0x" + "b".repeat(40), hours(23.9), hours(30)],  // trades_at stale only
        ["0x" + "c".repeat(40), hours(24), null],         // portfolio_at exactly 24 h: stale (the clock shows at 24 h)
        ["0x" + "d".repeat(40), hours(48), hours(48)],    // both stale
      ];
      for (const [address, portfolioAt, tradesAt] of rows) {
        await client.query("INSERT INTO discovery_traders (chain, address, in_pool, portfolio_at, trades_at) VALUES ('hyperliquid', $1, true, $2, $3)", [address, portfolioAt, tradesAt]);
      }
      await client.query("INSERT INTO discovery_traders (chain, address, in_pool, portfolio_at) VALUES ('hyperliquid', $1, true, NULL), ('hyperliquid', $2, false, $3)",
        ["0x" + "e".repeat(40), "0x" + "f".repeat(40), hours(100)]);
      await client.query("INSERT INTO leaderboard_imports (chain, imported_at) VALUES ('hyperliquid', $1)", [hours(2)]);
    } finally { await client.end(); }
    const { text, params } = buildQuery(NOW);
    const [{ report }] = await readOnlyQuery(url, text, params);
    const r = evaluate(report, ICON_OK);
    assert.equal(r.cards, 4);
    assert.deepEqual(r.stale, { portfolio_at: 2, trades_at: 2, missing_trades_at: 1 });
    assert.equal(r.pool_without_figures, 1);
    assert.equal(Date.parse(r.leaderboard.imported_at), Date.parse(hours(2)));
    assert.equal(r.leaderboard.as_of, null);
    assert.equal(r.verdict, "FAIL");
  });
});
