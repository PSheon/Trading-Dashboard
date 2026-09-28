"""Ask Dune which DEX project names exist, then sample wallets to compare.

Writes data/p0/venues.csv and data/p0/wallets.txt. Edit wallets.txt by hand to
swap in addresses you would rather check (e.g. ones from GMGN).
"""

import argparse

import polars as pl
from _common import P0_DIR, SETTINGS, WALLETS_FILE

from smartwallet.config import require
from smartwallet.constants import WSOL_MINT
from smartwallet.sources.dune import DuneClient

VENUES_SQL = """
SELECT project, version, count(*) AS trades
FROM dex_solana.trades
WHERE block_time >= now() - interval '1' hour
GROUP BY 1, 2
ORDER BY trades DESC
"""

# Wallets active on both the bonding curve and the AMM, busy enough to have
# history but not so busy they are obviously bots.
PICK_SQL = """
WITH w AS (
    SELECT
        trader_id,
        count(*) AS trades,
        count(DISTINCT CASE WHEN token_bought_mint_address = '{wsol}'
                            THEN token_sold_mint_address
                            ELSE token_bought_mint_address END) AS mints,
        count_if(project = '{curve}') AS curve_trades,
        count_if(project = '{amm}') AS amm_trades
    FROM dex_solana.trades
    WHERE block_time >= now() - interval '{days}' day
      AND project IN ('{curve}', '{amm}')
    GROUP BY 1
)
SELECT *
FROM w
WHERE trades BETWEEN {min_trades} AND {max_trades}
  AND mints >= {min_mints}
  AND curve_trades > 0
  AND amm_trades > 0
ORDER BY rand()
LIMIT {n}
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--n", type=int, default=5)
    p.add_argument("--days", type=int, default=3)
    p.add_argument("--curve", default="pumpdotfun", help="dex_solana.trades project of the curve")
    p.add_argument("--amm", default="pumpswap", help="dex_solana.trades project of the AMM")
    p.add_argument("--min-trades", type=int, default=20)
    p.add_argument("--max-trades", type=int, default=300)
    p.add_argument("--min-mints", type=int, default=5)
    p.add_argument("--force", action="store_true", help="overwrite an existing wallets.txt")
    args = p.parse_args()

    dune = DuneClient(require(SETTINGS.dune_api_key, "DUNE_API_KEY"))
    P0_DIR.mkdir(parents=True, exist_ok=True)

    execution_id, _, rows = dune.run(VENUES_SQL)
    venues = pl.DataFrame(rows)
    venues.write_csv(P0_DIR / "venues.csv")
    print(f"venues ({execution_id}):")
    print(venues)

    projects = set(venues["project"].to_list()) if len(venues) else set()
    missing = {args.curve, args.amm} - projects
    if missing:
        raise SystemExit(f"{sorted(missing)} not among projects above; pass --curve / --amm")

    if WALLETS_FILE.exists() and not args.force:
        raise SystemExit(f"{WALLETS_FILE} exists; pass --force to replace it")
    sql = PICK_SQL.format(
        wsol=WSOL_MINT,
        curve=args.curve,
        amm=args.amm,
        days=args.days,
        min_trades=args.min_trades,
        max_trades=args.max_trades,
        min_mints=args.min_mints,
        n=args.n,
    )
    execution_id, _, rows = dune.run(sql)
    picked = pl.DataFrame(rows)
    print(f"picked ({execution_id}):")
    print(picked)
    WALLETS_FILE.write_text(
        "".join(
            f"{r['trader_id']}  # {r['trades']} trades, {r['mints']} mints\n"
            for r in picked.iter_rows(named=True)
        )
    )
    print(f"wrote {WALLETS_FILE}")


if __name__ == "__main__":
    main()
