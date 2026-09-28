"""Fetch each wallet's history from Helius Parsed Events and keep the raw pages.

Transactions whose raw payload is missing or in an unreadable encoding are
fetched again with plain getTransaction, so every signature ends up with a
payload the normalizer can read.
"""

import argparse
import json
import time

from _common import P0_DIR, RAW_DIR, SETTINGS, read_wallets, run_stamp

from smartwallet import raw_store
from smartwallet.config import require
from smartwallet.sources.helius import HeliusClient, raw_transaction


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--days", type=int, default=180)
    args = p.parse_args()

    helius = HeliusClient(require(SETTINGS.helius_api_key, "HELIUS_API_KEY"))
    since = int(time.time()) - args.days * 86_400
    stamp = run_stamp()
    summary = {"run": stamp, "days": args.days, "since": since, "wallets": {}}

    for wallet in read_wallets():
        pages_path = RAW_DIR / "helius" / "transaction-history" / wallet / f"{stamp}.jsonl.gz"
        rpc_path = RAW_DIR / "helius" / "rpc" / wallet / f"{stamp}.jsonl.gz"
        start_credits = helius.credits_used
        pages = txs = 0
        unreadable: list[str] = []
        oldest = None
        for request, response in helius.transaction_history(wallet, time_gte=since):
            raw_store.append(
                pages_path,
                source="helius-parsed-events",
                request_key=f"transaction-history:{wallet}",
                request=request,
                response=response,
            )
            pages += 1
            for result in response.get("data", []):
                txs += 1
                bt = (result.get("parsed") or {}).get("blockTime")
                oldest = bt if oldest is None or (bt and bt < oldest) else oldest
                if raw_transaction(result) is None:
                    unreadable.append(result["signature"])
            print(f"{wallet[:8]} page {pages}: {txs} txs", end="\r")
        for sig in unreadable:
            raw_store.append(
                rpc_path,
                source="helius-rpc",
                request_key=f"getTransaction:{sig}",
                request={"signature": sig},
                response=helius.get_transaction(sig),
            )
        summary["wallets"][wallet] = {
            "pages": pages,
            "txs": txs,
            "refetched_via_rpc": len(unreadable),
            "oldest_block_time": oldest,
            "credits": helius.credits_used - start_credits,
        }
        print(
            f"{wallet}: {txs} txs, {pages} pages, {len(unreadable)} refetched, "
            f"{helius.credits_used - start_credits} credits"
        )

    summary["credits_total"] = helius.credits_used
    P0_DIR.mkdir(parents=True, exist_ok=True)
    (P0_DIR / "helius_fetch.json").write_text(json.dumps(summary, indent=2))
    print(f"total credits: {helius.credits_used}")


if __name__ == "__main__":
    main()
