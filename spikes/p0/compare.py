"""Compare Helius-derived deltas with Dune's dex_solana.trades and write a report.

Helius side: every raw transaction goes through the balance-delta normalizer.
Dune side: rows are netted to (tx, trader, mint), the same grain.
Only the Dune window is compared; the Helius window is used for cost numbers.

Writes data/p0/report.md, data/p0/helius_deltas.parquet, data/p0/joined.parquet.
"""

import argparse
import json
import math
from dataclasses import asdict

import polars as pl
from _common import P0_DIR, RAW_DIR, read_wallets

from smartwallet import raw_store
from smartwallet.constants import QUOTE_MINTS, WSOL_MINT
from smartwallet.normalize import wallet_deltas
from smartwallet.sources.helius import PARSED_EVENTS_CREDITS, raw_transaction

SAMPLES = 8


def helius_frames(wallets: list[str], stamp: str) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(deltas, per-transaction program names) for every wallet in the run."""
    deltas, programs = [], []
    for wallet in wallets:
        rpc = {}
        rpc_path = RAW_DIR / "helius" / "rpc" / wallet / f"{stamp}.jsonl.gz"
        if rpc_path.exists():
            rpc = {r["request"]["signature"]: r["response"] for r in raw_store.read(rpc_path)}
        pages_path = RAW_DIR / "helius" / "transaction-history" / wallet / f"{stamp}.jsonl.gz"
        for record in raw_store.read(pages_path):
            for result in record["response"].get("data", []):
                sig = result["signature"]
                raw = raw_transaction(result) or rpc.get(sig)
                if raw is None:
                    continue
                deltas.extend(asdict(d) for d in wallet_deltas(raw, wallet))
                names = sorted(
                    {
                        i.get("programName") or i.get("programId") or "?"
                        for i in (result.get("parsed") or {}).get("instructions", [])
                    }
                )
                programs.append(
                    {
                        "tx_sig": sig,
                        "wallet": wallet,
                        "programs": names,
                        "parser_status": result.get("parserStatus"),
                    }
                )
    schema_deltas = pl.DataFrame(deltas, infer_schema_length=None) if deltas else pl.DataFrame()
    return schema_deltas, pl.DataFrame(programs)


def dune_frame(path) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(non-quote mint deltas with SOL leg, raw rows) at (tx, trader, mint) grain."""
    rows = pl.read_parquet(path)
    legs = pl.concat(
        [
            rows.select(
                "tx_id",
                "trader_id",
                "project",
                "block_time",
                mint="token_bought_mint_address",
                amount=pl.col("token_bought_amount_raw").cast(pl.Int64, strict=False),
            ),
            rows.select(
                "tx_id",
                "trader_id",
                "project",
                "block_time",
                mint="token_sold_mint_address",
                amount=-pl.col("token_sold_amount_raw").cast(pl.Int64, strict=False),
            ),
        ]
    )
    per_tx = legs.group_by("tx_id", "trader_id").agg(
        sol=pl.col("amount").filter(pl.col("mint") == WSOL_MINT).sum(),
        projects=pl.col("project").unique().sort(),
        hops=pl.len() // 2,
    )
    movers = (
        legs.filter(~pl.col("mint").is_in(list(QUOTE_MINTS)))
        .group_by("tx_id", "trader_id", "mint")
        .agg(dune_token=pl.col("amount").sum(), block_time=pl.col("block_time").first())
        .filter(pl.col("dune_token") != 0)
        .join(per_tx, on=["tx_id", "trader_id"], how="left")
        .rename({"tx_id": "tx_sig", "trader_id": "wallet", "sol": "dune_sol"})
    )
    return movers, rows


def md_table(df: pl.DataFrame) -> str:
    if df.is_empty():
        return "_(none)_\n"
    cols = df.columns
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for row in df.iter_rows():
        lines.append("| " + " | ".join(_fmt(v) for v in row) + " |")
    return "\n".join(lines) + "\n"


def _fmt(v) -> str:
    if isinstance(v, float):
        return "" if math.isnan(v) else f"{v:.4g}"
    if isinstance(v, list):
        return ", ".join(map(str, v))
    return "" if v is None else str(v)


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    wallets = read_wallets()
    hf = json.loads((P0_DIR / "helius_fetch.json").read_text())
    df_meta = json.loads((P0_DIR / "dune_fetch.json").read_text())
    since = df_meta["since"]

    deltas, programs = helius_frames(wallets, hf["run"])
    deltas.write_parquet(P0_DIR / "helius_deltas.parquet")
    dune, dune_rows = dune_frame(P0_DIR / "dune_trades.parquet")

    window = deltas.filter(pl.col("block_time") >= since)
    h_trades = window.filter(pl.col("kind") == "trade").select(
        "tx_sig",
        "wallet",
        "mint",
        "side",
        "quote_mint",
        "block_time",
        helius_token="token_amount_raw",
        helius_quote="quote_amount_raw",
    )
    joined = h_trades.join(
        dune.drop("block_time"), on=["tx_sig", "wallet", "mint"], how="full", coalesce=True
    )
    joined = joined.join(
        programs.select("tx_sig", "wallet", "programs"), on=["tx_sig", "wallet"], how="left"
    )
    joined.write_parquet(P0_DIR / "joined.parquet")

    both = joined.filter(pl.col("helius_token").is_not_null() & pl.col("dune_token").is_not_null())
    h_only = joined.filter(pl.col("dune_token").is_null())
    d_only = joined.filter(pl.col("helius_token").is_null())
    sol_both = both.filter((pl.col("quote_mint") == WSOL_MINT) & (pl.col("dune_sol") != 0))
    rel = (pl.col("helius_quote") - pl.col("dune_sol")).abs() / pl.col("dune_sol").abs()
    sol_diff = sol_both.select(rel.alias("rel"))["rel"]

    out = [
        f"# P0 source comparison\n\nHelius run `{hf['run']}` ({hf['days']} days); "
        f"compared window: last {df_meta['days']} days (Dune `{df_meta['execution_id']}`).\n"
    ]

    out.append("\n## Coverage: (tx, wallet, mint) trades\n\n")
    per_wallet = (
        pl.DataFrame({"wallet": wallets})
        .join(
            joined.group_by("wallet").agg(
                both=(
                    pl.col("helius_token").is_not_null() & pl.col("dune_token").is_not_null()
                ).sum(),
                helius_only=pl.col("dune_token").is_null().sum(),
                dune_only=pl.col("helius_token").is_null().sum(),
            ),
            on="wallet",
            how="left",
        )
        .join(
            window.group_by("wallet").agg(
                transfers=(pl.col("kind") == "transfer").sum(),
                complex=(pl.col("kind") == "complex").sum(),
            ),
            on="wallet",
            how="left",
        )
    )
    out.append(md_table(per_wallet))
    total = len(joined)
    if total:
        out.append(
            f"\nMatched {len(both)}/{total} ({len(both) / total:.1%}); "
            f"Helius only {len(h_only)}, Dune only {len(d_only)}.\n"
        )

    out.append("\n## Amount agreement on matched rows\n")
    if len(both):
        exact = both.filter(pl.col("helius_token") == pl.col("dune_token")).height
        out.append(f"- Token amount identical: {exact}/{len(both)} ({exact / len(both):.1%})\n")
    if len(sol_diff):
        out.append(
            f"- SOL leg, |Helius − Dune| / Dune over {len(sol_diff)} rows: "
            f"median {sol_diff.median():.3%}, p95 {sol_diff.quantile(0.95):.3%}, "
            f"within 1%: {(sol_diff <= 0.01).mean():.1%}\n"
            "  (Helius SOL excludes network fee, Jito tip and rent but includes bot fees "
            "paid by transfer; Dune's is the pool leg only.)\n"
        )
    multi = dune.filter(pl.col("hops") > 1).height
    out.append(f"- Dune rows that took more than one hop: {multi}/{len(dune)}\n")

    out.append("\n## Venues\n\nDune projects in the compared rows:\n\n")
    out.append(
        md_table(dune_rows.group_by("project", "version").len().sort("len", descending=True))
    )
    out.append("\nPrograms in transactions Helius classed as trades:\n\n")
    trade_programs = (
        window.filter(pl.col("kind") == "trade")
        .select("tx_sig", "wallet")
        .unique()
        .join(programs, on=["tx_sig", "wallet"])
        .explode("programs", empty_as_null=True)
        .group_by("programs")
        .len()
        .sort("len", descending=True)
        .head(25)
    )
    out.append(md_table(trade_programs))
    statuses = programs.group_by("parser_status").len()
    out.append("\nParsed Events parser status over all fetched transactions:\n\n")
    out.append(md_table(statuses))

    out.append("\n## Samples to inspect on Solscan\n\nHelius only:\n\n")
    out.append(
        md_table(h_only.select("wallet", "tx_sig", "mint", "side", "programs").head(SAMPLES))
    )
    out.append("\nDune only:\n\n")
    out.append(
        md_table(d_only.select("wallet", "tx_sig", "mint", "projects", "hops").head(SAMPLES))
    )

    out.append("\n## Cost\n\n")
    cost = pl.DataFrame(
        [
            {"wallet": w, **{k: v for k, v in s.items() if k != "oldest_block_time"}}
            for w, s in hf["wallets"].items()
        ]
    )
    out.append(md_table(cost))
    txs_per_day = cost["txs"].sum() / len(cost) / hf["days"] if len(cost) else 0
    backfill = cost["credits"].mean() if len(cost) else 0
    daily_requests = max(1, math.ceil(txs_per_day / 100))
    monthly_1k = daily_requests * PARSED_EVENTS_CREDITS * 30 * 1000
    out.append(
        f"\n- Backfill: {backfill:,.0f} credits per wallet for {hf['days']} days on average "
        f"→ {backfill * 1000:,.0f} for 1,000 wallets\n"
        f"- Activity: {txs_per_day:.1f} transactions per wallet per day on average\n"
        f"- Daily incremental at that rate: {daily_requests} request(s) per wallet "
        f"→ {monthly_1k:,} credits per month for 1,000 wallets polled daily "
        "(free plan: 1,000,000 per month)\n"
    )

    (P0_DIR / "report.md").write_text("".join(out))
    print(f"wrote {P0_DIR / 'report.md'}")


if __name__ == "__main__":
    main()
