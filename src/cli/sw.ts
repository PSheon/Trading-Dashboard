// `npm run sw -- <command>`. The web server runs the daily job on its own
// schedule; these commands are for running steps by hand.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { runChecks } from "../lib/check";
import { context } from "../lib/context";
import { BACKFILL_DAYS, daily, dayOf, fetchWallets, ingestWallets, reconcileWallets, repairWallets, sample, stampOf } from "../lib/jobs";
import { summarize } from "../lib/reconcile";
import { dayRange, maintainSnapshots, snapshotDay, verifyDay } from "../lib/snapshots";
import { syncTokens } from "../lib/tokens";
import { addWallets, dueWallets, loadWallets, VIA } from "../lib/wallets";

const HELP = `usage: npm run sw -- <command> [options]

  add-wallets <file> --via <${VIA.join("|")}> [--from-token M] [--funnel-run R]
  fetch     [--wallet A ...] [--backfill-days 180]   pull new history (default: wallets that are due)
  ingest    [--wallet A ...]                        re-parse raw into trades, transfers, lots, positions
  repair    [--wallet A ...]                        fetch token-account history for unreconciled mints
  tokens                                            sync token creation / graduation times from Dune
  snapshot  [--date D | --from D --to D]            recompute whole days (default: maintain through today)
  verify    [--date D | --all]                      recompute stored days and compare (default: a random day)
  reconcile [--wallet A ...] [--sample 20]          compare derived balances with the chain
  check                                             integrity checks; exits 1 on failure
  daily     [--reconcile-sample 20]                 everything above, in order, for wallets that are due`;

const json = (v: unknown) =>
  console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

export function readAddresses(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.split("#")[0].trim())
    .filter(Boolean);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      wallet: { type: "string", multiple: true },
      via: { type: "string" },
      "from-token": { type: "string" },
      "funnel-run": { type: "string" },
      "backfill-days": { type: "string" },
      date: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      sample: { type: "string" },
      "reconcile-sample": { type: "string" },
      all: { type: "boolean" },
    },
  });
  const ctx = context();
  const now = Math.floor(Date.now() / 1000);
  const registered = async () => (await loadWallets(ctx.wh)).map((w) => w.address);
  const targets = async () => values.wallet ?? (await registered());

  switch (cmd) {
    case "add-wallets": {
      if (!positionals[0] || !VIA.includes(values.via as (typeof VIA)[number])) throw new Error(HELP);
      const added = await addWallets(ctx.wh, readAddresses(positionals[0]), {
        via: values.via!,
        now,
        fromToken: values["from-token"],
        funnelRunId: values["funnel-run"],
      });
      console.log(`added ${added.length} new wallet(s); ${(await registered()).length} registered`);
      return;
    }
    case "fetch": {
      const wallets = values.wallet ?? dueWallets(await loadWallets(ctx.wh), now);
      const r = await fetchWallets(ctx.wh, ctx.helius(), ctx.rawDir, wallets, {
        now,
        stamp: stampOf(now),
        backfillDays: Number(values["backfill-days"] ?? BACKFILL_DAYS),
        creditBudget: ctx.creditBudget,
      });
      json({ fetched: Object.keys(r.fetched).length, skipped: r.skipped.length, errors: r.errors, credits: r.credits });
      return;
    }
    case "ingest":
      json(await ingestWallets(ctx.wh, ctx.rawDir, await targets(), now));
      return;
    case "repair":
      json(await repairWallets(ctx.wh, ctx.helius(), ctx.rawDir, await targets(), { now, stamp: stampOf(now), creditBudget: ctx.creditBudget }));
      return;
    case "tokens": {
      const dune = ctx.dune();
      if (!dune) throw new Error("DUNE_API_KEY is not set; add it to .env (see .env.example)");
      json(await syncTokens(ctx.wh, dune, { now }));
      return;
    }
    case "snapshot": {
      if (values.from || values.to || values.date) {
        const days = values.date ? [values.date] : values.from && values.to ? dayRange(values.from, values.to) : null;
        if (!days) throw new Error("--from and --to go together");
        for (const day of days) console.log(`${day}: ${await snapshotDay(ctx.wh, day)} wallets`);
      } else {
        json(await maintainSnapshots(ctx.wh, dayOf(now)));
      }
      return;
    }
    case "verify": {
      const stored = ctx.wh.days("wallet_metrics_daily");
      const days = values.all ? stored : [values.date ?? sample(stored, 1)[0]].filter(Boolean);
      if (!days.length) throw new Error("no stored snapshots");
      const bad = [];
      for (const day of days) {
        const r = await verifyDay(ctx.wh, day);
        if (r.mismatched.length) bad.push(r);
      }
      json({ days: days.length, mismatched_days: bad.length, first: bad.slice(0, 3) });
      if (bad.length) process.exitCode = 1;
      return;
    }
    case "reconcile": {
      const all = values.wallet ?? (await registered());
      const picked = values.wallet ? all : sample(all, Number(values.sample ?? 20));
      const r = await reconcileWallets(ctx.wh, ctx.helius(), picked, now);
      json({ ...summarize(r.rows), errors: r.errors });
      return;
    }
    case "check": {
      const r = await runChecks(ctx.wh);
      for (const c of r.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "daily":
      json(
        await daily(ctx.wh, ctx.helius(), ctx.rawDir, {
          now,
          dune: ctx.dune(),
          creditBudget: ctx.creditBudget,
          reconcileSample: Number(values["reconcile-sample"] ?? 20),
        }),
      );
      return;
    default:
      console.log(HELP);
      if (cmd && cmd !== "help") process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
