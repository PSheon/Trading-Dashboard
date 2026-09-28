"""`sw` command line. `sw daily` is what cron runs once a day after 00:00 UTC."""

import argparse
import json
import random
import time
from datetime import UTC, date, datetime
from pathlib import Path

from . import config, jobs, reconcile, wallets
from .sources.helius import HeliusClient
from .store import Warehouse

VIA = ("token_funnel", "public_leaderboard", "manual")


def read_addresses(path: Path) -> list[str]:
    lines = (line.split("#")[0].strip() for line in path.read_text().splitlines())
    return [line for line in lines if line]


def _today() -> date:
    return datetime.now(UTC).date()


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="sw", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add-wallets", help="register addresses from a file, one per line")
    a.add_argument("file", type=Path)
    a.add_argument("--via", choices=VIA, required=True)
    a.add_argument("--from-token")
    a.add_argument("--funnel-run")

    f = sub.add_parser("fetch", help="pull new history (default: wallets that are due)")
    f.add_argument("--wallet", action="append")
    f.add_argument("--backfill-days", type=int, default=jobs.BACKFILL_DAYS)

    i = sub.add_parser("ingest", help="re-parse raw into trades, transfers, lots, positions")
    i.add_argument("--wallet", action="append")

    s = sub.add_parser("snapshot", help="write wallet_metrics_daily")
    s.add_argument("--date", type=date.fromisoformat, help="as_of_date (default: today UTC)")
    s.add_argument("--from", dest="start", type=date.fromisoformat)
    s.add_argument("--to", dest="end", type=date.fromisoformat)

    r = sub.add_parser("reconcile", help="compare derived balances with the chain")
    r.add_argument("--wallet", action="append")
    r.add_argument("--sample", type=int, default=20)

    rp = sub.add_parser("repair", help="fetch token-account history for unreconciled mints")
    rp.add_argument("--wallet", action="append")

    d = sub.add_parser("daily", help="fetch, ingest, repair, snapshot today, reconcile a sample")
    d.add_argument("--reconcile-sample", type=int, default=20)

    args = p.parse_args(argv)
    settings = config.load()
    wh = Warehouse(settings.data_dir / "warehouse")
    raw_dir = settings.data_dir / "raw"
    now = int(time.time())

    def helius() -> HeliusClient:
        return HeliusClient(config.require(settings.helius_api_key, "HELIUS_API_KEY"))

    def registered() -> list[str]:
        return wallets.load(wh)["address"].to_list()

    if args.cmd == "add-wallets":
        added = wallets.add(
            wh,
            read_addresses(args.file),
            discovered_via=args.via,
            now=now,
            discovered_from_token=args.from_token,
            funnel_run_id=args.funnel_run,
        )
        print(f"added {len(added)} new wallet(s); {len(registered())} registered")

    elif args.cmd == "fetch":
        targets = args.wallet or wallets.due(wallets.load(wh), now)
        stamp = datetime.fromtimestamp(now, UTC).strftime("%Y%m%dT%H%M%SZ")
        h = helius()
        result = jobs.fetch(
            wh, h, raw_dir, targets, now=now, stamp=stamp, backfill_days=args.backfill_days
        )
        print(json.dumps({"wallets": len(result), "credits": h.credits_used}, indent=2))

    elif args.cmd == "ingest":
        print(jobs.ingest(wh, raw_dir, args.wallet or registered(), now=now))

    elif args.cmd == "snapshot":
        if args.start or args.end:
            if not (args.start and args.end):
                p.error("--from and --to go together")
            for day, n in jobs.snapshot_range(wh, args.start, args.end).items():
                print(f"{day}: {n} wallets")
        else:
            day = args.date or _today()
            print(f"{day}: {jobs.snapshot(wh, day)} wallets")

    elif args.cmd == "reconcile":
        targets = args.wallet or _sample(registered(), args.sample)
        rows = jobs.reconcile_wallets(wh, helius(), targets, now=now)
        print(json.dumps(reconcile.summary(rows), indent=2))

    elif args.cmd == "repair":
        stamp = datetime.fromtimestamp(now, UTC).strftime("%Y%m%dT%H%M%SZ")
        result = jobs.repair(
            wh, helius(), raw_dir, args.wallet or registered(), now=now, stamp=stamp
        )
        print(json.dumps(result, indent=2))

    elif args.cmd == "daily":
        result = jobs.daily(wh, helius(), raw_dir, now=now, reconcile_sample=args.reconcile_sample)
        print(json.dumps(result, indent=2, default=str))


def _sample(addresses: list[str], n: int) -> list[str]:
    return random.sample(addresses, min(n, len(addresses)))


if __name__ == "__main__":
    main()
