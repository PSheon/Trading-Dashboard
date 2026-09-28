// `npm run sw -- <command>`. The web server runs the daily job on its own
// schedule; these commands are for running steps by hand.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { context } from "../lib/context";
import {
  BACKFILL_DAYS, daily, dayOf, fetchWallets, ingestWallets, reconcileWallets, repairWallets, snapshot,
  snapshotRange, stampOf,
} from "../lib/jobs";
import { summarize } from "../lib/reconcile";
import { addWallets, dueWallets, loadWallets, VIA } from "../lib/wallets";

const HELP = `usage: npm run sw -- <command> [options]

  add-wallets <file> --via <${VIA.join("|")}> [--from-token M] [--funnel-run R]
  fetch     [--wallet A ...] [--backfill-days 180]   pull new history (default: wallets that are due)
  ingest    [--wallet A ...]                        re-parse raw into trades, transfers, lots, positions
  repair    [--wallet A ...]                        fetch token-account history for unreconciled mints
  snapshot  [--date D | --from D --to D]            write wallet_metrics_daily (default: today UTC)
  reconcile [--wallet A ...] [--sample 20]          compare derived balances with the chain
  daily     [--reconcile-sample 20]                 fetch, ingest, repair, snapshot today, reconcile`;

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
      const helius = ctx.helius();
      const wallets = values.wallet ?? dueWallets(await loadWallets(ctx.wh), now);
      const result = await fetchWallets(ctx.wh, helius, ctx.rawDir, wallets, {
        now,
        stamp: stampOf(now),
        backfillDays: Number(values["backfill-days"] ?? BACKFILL_DAYS),
      });
      json({ wallets: Object.keys(result).length, credits: helius.credits });
      return;
    }
    case "ingest":
      json(await ingestWallets(ctx.wh, ctx.rawDir, await targets(), now));
      return;
    case "repair":
      json(await repairWallets(ctx.wh, ctx.helius(), ctx.rawDir, await targets(), { now, stamp: stampOf(now) }));
      return;
    case "snapshot": {
      if (values.from || values.to) {
        if (!values.from || !values.to) throw new Error("--from and --to go together");
        for (const [day, n] of Object.entries(await snapshotRange(ctx.wh, values.from, values.to))) {
          console.log(`${day}: ${n} wallets`);
        }
      } else {
        const day = values.date ?? dayOf(now);
        console.log(`${day}: ${await snapshot(ctx.wh, day)} wallets`);
      }
      return;
    }
    case "reconcile": {
      const all = values.wallet ?? (await registered());
      const n = Number(values.sample ?? 20);
      const picked = values.wallet ? all : [...all].sort(() => Math.random() - 0.5).slice(0, n);
      json(summarize(await reconcileWallets(ctx.wh, ctx.helius(), picked, now)));
      return;
    }
    case "daily":
      json(
        await daily(ctx.wh, ctx.helius(), ctx.rawDir, {
          now,
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
