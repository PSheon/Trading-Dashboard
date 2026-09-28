"""Fetch the same wallets' trades from Dune's dex_solana.trades."""

import argparse
import json
import time

import polars as pl
from _common import P0_DIR, SETTINGS, read_wallets

from smartwallet.config import require
from smartwallet.sources.dune import DuneClient

TRADES_SQL = """
SELECT
    tx_id,
    trader_id,
    to_unixtime(block_time) AS block_time,
    block_slot,
    project,
    version,
    outer_instruction_index,
    inner_instruction_index,
    token_bought_mint_address,
    CAST(token_bought_amount_raw AS varchar) AS token_bought_amount_raw,
    token_sold_mint_address,
    CAST(token_sold_amount_raw AS varchar) AS token_sold_amount_raw
FROM dex_solana.trades
WHERE block_time >= from_unixtime({since})
  AND trader_id IN ({wallets})
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--days",
        type=int,
        default=30,
        help="shorter than the Helius window; this is the window compared",
    )
    args = p.parse_args()

    wallets = read_wallets()
    since = int(time.time()) - args.days * 86_400
    dune = DuneClient(require(SETTINGS.dune_api_key, "DUNE_API_KEY"))
    sql = TRADES_SQL.format(since=since, wallets=", ".join(f"'{w}'" for w in wallets))
    execution_id, status, rows = dune.run(sql)

    P0_DIR.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows, infer_schema_length=None).write_parquet(P0_DIR / "dune_trades.parquet")
    (P0_DIR / "dune_fetch.json").write_text(
        json.dumps(
            {
                "execution_id": execution_id,
                "since": since,
                "days": args.days,
                "rows": len(rows),
                "status": status,
            },
            indent=2,
            default=str,
        )
    )
    print(f"{len(rows)} rows ({execution_id}) since {since}")


if __name__ == "__main__":
    main()
