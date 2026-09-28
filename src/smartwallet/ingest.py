"""Raw responses → `trades` and `token_transfers`.

Always a full re-parse of the wallets asked for: every raw file they have is
read again and their rows are replaced. Cheap at this scale, and it means a
parser fix reaches old data without anyone remembering to backfill.
"""

import time
from collections.abc import Iterator
from pathlib import Path

import polars as pl

from . import raw_store
from .constants import WSOL_MINT
from .normalize import counterparty, wallet_deltas
from .sources.helius import raw_transaction
from .store import conform, empty

PARSER_VERSION = 1
# A SOL leg this small moves the implied price a lot with each lamport of fee
# or rounding, so its price is marked low confidence.
LOW_CONFIDENCE_LAMPORTS = 10_000_000  # 0.01 SOL


def history_dir(raw_dir: Path, wallet: str) -> Path:
    return raw_dir / "helius" / "transaction-history" / wallet


def rpc_dir(raw_dir: Path, wallet: str) -> Path:
    return raw_dir / "helius" / "rpc" / wallet


def raw_transactions(raw_dir: Path, wallet: str) -> Iterator[tuple[str, dict, list[str]]]:
    """(signature, getTransaction payload, program names) for each distinct transaction."""
    rpc: dict[str, dict] = {}
    for path in sorted(rpc_dir(raw_dir, wallet).glob("*.jsonl.gz")):
        for r in raw_store.read(path):
            if r["response"] is not None:
                rpc[r["request"]["signature"]] = r["response"]
    seen: set[str] = set()
    for path in sorted(history_dir(raw_dir, wallet).glob("*.jsonl.gz")):
        for record in raw_store.read(path):
            for result in record["response"].get("data", []):
                sig = result["signature"]
                if sig in seen:
                    continue
                raw = raw_transaction(result) or rpc.get(sig)
                if raw is None:
                    continue
                seen.add(sig)
                instructions = (result.get("parsed") or {}).get("instructions", [])
                programs = sorted(
                    {i.get("programName") or i.get("programId") or "?" for i in instructions}
                )
                yield sig, raw, programs


def parse_wallet(raw_dir: Path, wallet: str, *, ingested_at: int | None = None):
    """(trades, token_transfers) rows for one wallet."""
    ingested_at = ingested_at if ingested_at is not None else int(time.time())
    trades, transfers = [], []
    for _, raw, programs in raw_transactions(raw_dir, wallet):
        for d in wallet_deltas(raw, wallet):
            common = {
                "tx_sig": d.tx_sig,
                "wallet": d.wallet,
                "mint": d.mint,
                "decimals": d.decimals,
                "slot": d.slot,
                "block_time": d.block_time,
                "parser_version": PARSER_VERSION,
                "ingested_at": ingested_at,
            }
            if d.kind == "trade":
                sol = abs(d.quote_amount_raw) if d.quote_mint == WSOL_MINT else None
                tokens = abs(d.token_amount_raw)
                trades.append(
                    common
                    | {
                        "side": d.side,
                        "token_amount_raw": tokens,
                        "quote_mint": d.quote_mint,
                        "quote_amount_raw": abs(d.quote_amount_raw),
                        "sol_lamports": sol,
                        "fee_lamports": d.fee_lamports,
                        "rent_lamports": d.rent_lamports,
                        "price_sol": (sol / 1e9) / (tokens / 10**d.decimals) if sol else None,
                        "price_confidence": (
                            None
                            if sol is None
                            else "low"
                            if sol < LOW_CONFIDENCE_LAMPORTS
                            else "normal"
                        ),
                        "programs": programs,
                    }
                )
            else:
                transfers.append(
                    common
                    | {
                        "direction": "in" if d.token_amount_raw > 0 else "out",
                        "kind": d.kind,
                        "token_amount_raw": abs(d.token_amount_raw),
                        "counterparty": counterparty(raw, wallet, d.mint, d.token_amount_raw),
                    }
                )
    return _frame(trades, "trades"), _frame(transfers, "token_transfers")


def _frame(rows: list[dict], table: str) -> pl.DataFrame:
    if not rows:
        return empty(table)
    return conform(pl.DataFrame(rows, infer_schema_length=None), table)
