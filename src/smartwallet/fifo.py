"""FIFO lot matching and positions for one (wallet, mint).

All amounts are integers: raw token units and lamports. A cost or proceeds
split across pieces is divided proportionally with the remainder carried, so
pieces always add back up to the original exactly.

A position runs from the first acquisition while flat to the moment holdings
return to zero (or to dust). It is the unit metrics count; lots are the
accounting underneath.
"""

from collections import deque
from dataclasses import dataclass, field

import polars as pl

DUST_RATIO = 0.001  # holdings at or below this share of the position's peak count as flat


@dataclass(frozen=True)
class Event:
    tx_sig: str
    slot: int
    block_time: int
    kind: str  # buy | sell | transfer_in | transfer_out
    amount: int  # signed raw token amount
    sol: int | None  # buy: lamports paid incl. fees; sell: lamports received net of fees


@dataclass(frozen=True)
class Lot:
    wallet: str
    mint: str
    lot_seq: int
    position_seq: int
    buy_tx_sig: str | None
    buy_time: int | None
    close_tx_sig: str | None
    close_time: int | None
    close_type: str | None  # sell | transfer_out | dust | None while open
    token_amount_raw: int
    cost_lamports: int | None
    proceeds_lamports: int | None
    realized_pnl_lamports: int | None
    hold_seconds: int | None
    cost_unknown: bool


@dataclass(frozen=True)
class Position:
    wallet: str
    mint: str
    position_seq: int
    opened_at: int
    closed_at: int | None
    cost_lamports: int
    proceeds_lamports: int
    realized_pnl_lamports: int | None  # only for complete positions
    lots: int
    has_unknown_cost: bool
    has_transfer_out: bool
    complete: bool  # closed, every cost and proceeds known, nothing transferred away


@dataclass
class _Open:
    amount: int
    cost: int | None
    buy_tx_sig: str | None
    buy_time: int | None
    cost_unknown: bool


@dataclass
class _Pos:
    seq: int
    opened_at: int
    held: int = 0
    peak: int = 0
    lots: list[Lot] = field(default_factory=list)


def _share(total: int | None, piece: int, whole: int) -> int | None:
    return None if total is None else total * piece // whole


def run_fifo(
    wallet: str, mint: str, events: list[Event], *, dust_ratio: float = DUST_RATIO
) -> tuple[list[Lot], list[Position]]:
    """Events must already be in chain order (slot, then tx_sig)."""
    open_lots: deque[_Open] = deque()
    lots: list[Lot] = []
    positions: list[Position] = []
    pos: _Pos | None = None

    def close(o: _Open | None, piece: int, cost, proceeds, e: Event, close_type: str) -> Lot:
        cost_unknown = o is None or o.cost_unknown
        pnl = None
        if close_type in ("sell", "dust") and not cost_unknown and proceeds is not None:
            pnl = proceeds - cost
        lot = Lot(
            wallet=wallet,
            mint=mint,
            # One buy sold in pieces yields several lots, so number them as emitted.
            lot_seq=len(lots) + len(pos.lots),
            position_seq=pos.seq,
            buy_tx_sig=o.buy_tx_sig if o else None,
            buy_time=o.buy_time if o else None,
            close_tx_sig=e.tx_sig,
            close_time=e.block_time,
            close_type=close_type,
            token_amount_raw=piece,
            cost_lamports=cost,
            proceeds_lamports=proceeds,
            realized_pnl_lamports=pnl,
            hold_seconds=e.block_time - o.buy_time if o and o.buy_time is not None else None,
            cost_unknown=cost_unknown,
        )
        pos.lots.append(lot)
        return lot

    for e in events:
        if pos is None:
            pos = _Pos(seq=len(positions), opened_at=e.block_time)

        if e.amount > 0:
            known = e.kind == "buy" and e.sol is not None
            open_lots.append(
                _Open(
                    amount=e.amount,
                    cost=e.sol if known else None,
                    buy_tx_sig=e.tx_sig,
                    buy_time=e.block_time,
                    cost_unknown=not known,
                )
            )
            pos.held += e.amount
            pos.peak = max(pos.peak, pos.held)
        elif e.amount < 0:
            close_type = "sell" if e.kind == "sell" else "transfer_out"
            remaining = -e.amount
            proceeds_left = e.sol if close_type == "sell" else None
            while remaining > 0:
                o = open_lots[0] if open_lots else None
                piece = min(o.amount, remaining) if o else remaining
                cost = None
                if o:
                    cost = _share(o.cost, piece, o.amount)
                    o.cost = None if o.cost is None else o.cost - cost
                    o.amount -= piece
                    pos.held -= piece
                    if o.amount == 0:
                        open_lots.popleft()
                proceeds = _share(proceeds_left, piece, remaining)
                if proceeds_left is not None:
                    proceeds_left -= proceeds
                remaining -= piece
                close(o, piece, cost, proceeds, e, close_type)

        if pos.held <= pos.peak * dust_ratio:
            while open_lots:
                o = open_lots.popleft()
                close(o, o.amount, o.cost, 0, e, "dust")
            lots.extend(pos.lots)
            positions.append(_finish(wallet, mint, pos, closed_at=e.block_time))
            pos = None

    if pos is not None:
        for o in open_lots:
            pos.lots.append(
                Lot(
                    wallet=wallet,
                    mint=mint,
                    lot_seq=len(lots) + len(pos.lots),
                    position_seq=pos.seq,
                    buy_tx_sig=o.buy_tx_sig,
                    buy_time=o.buy_time,
                    close_tx_sig=None,
                    close_time=None,
                    close_type=None,
                    token_amount_raw=o.amount,
                    cost_lamports=o.cost,
                    proceeds_lamports=None,
                    realized_pnl_lamports=None,
                    hold_seconds=None,
                    cost_unknown=o.cost_unknown,
                )
            )
        lots.extend(pos.lots)
        positions.append(_finish(wallet, mint, pos, closed_at=None))
    return lots, positions


def _finish(wallet: str, mint: str, pos: _Pos, closed_at: int | None) -> Position:
    closed_lots = [lot for lot in pos.lots if lot.close_type is not None]
    has_unknown_cost = any(lot.cost_unknown for lot in pos.lots)
    has_transfer_out = any(lot.close_type == "transfer_out" for lot in pos.lots)
    complete = (
        closed_at is not None
        and not has_unknown_cost
        and not has_transfer_out
        and all(lot.realized_pnl_lamports is not None for lot in closed_lots)
    )
    return Position(
        wallet=wallet,
        mint=mint,
        position_seq=pos.seq,
        opened_at=pos.opened_at,
        closed_at=closed_at,
        cost_lamports=sum(lot.cost_lamports or 0 for lot in pos.lots),
        proceeds_lamports=sum(lot.proceeds_lamports or 0 for lot in closed_lots),
        realized_pnl_lamports=(
            sum(lot.realized_pnl_lamports for lot in closed_lots) if complete else None
        ),
        lots=len(pos.lots),
        has_unknown_cost=has_unknown_cost,
        has_transfer_out=has_transfer_out,
        complete=complete,
    )


def events_frame(trades: pl.DataFrame, transfers: pl.DataFrame) -> pl.DataFrame:
    """Trades and transfers as one chain-ordered event stream."""
    t = trades.select(
        "wallet",
        "mint",
        "tx_sig",
        "slot",
        "block_time",
        kind="side",
        amount=pl.when(pl.col("side") == "buy")
        .then(pl.col("token_amount_raw"))
        .otherwise(-pl.col("token_amount_raw")),
        sol=pl.when(pl.col("side") == "buy")
        .then(pl.col("sol_lamports") + pl.col("fee_lamports"))
        .otherwise(pl.col("sol_lamports") - pl.col("fee_lamports")),
    )
    x = transfers.select(
        "wallet",
        "mint",
        "tx_sig",
        "slot",
        "block_time",
        kind=pl.concat_str(pl.lit("transfer_"), pl.col("direction")),
        amount=pl.when(pl.col("direction") == "in")
        .then(pl.col("token_amount_raw"))
        .otherwise(-pl.col("token_amount_raw")),
        sol=pl.lit(None, dtype=pl.Int64),
    )
    return pl.concat([t, x]).sort("wallet", "mint", "slot", "tx_sig")


def build(trades: pl.DataFrame, transfers: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Lots and positions for every (wallet, mint) in the inputs."""
    all_lots: list[Lot] = []
    all_positions: list[Position] = []
    events = events_frame(trades, transfers)
    for (wallet, mint), group in events.group_by("wallet", "mint", maintain_order=True):
        stream = [
            Event(r["tx_sig"], r["slot"], r["block_time"], r["kind"], r["amount"], r["sol"])
            for r in group.iter_rows(named=True)
        ]
        lots, positions = run_fifo(wallet, mint, stream)
        all_lots.extend(lots)
        all_positions.extend(positions)
    return (
        pl.DataFrame(all_lots, schema=_schema("lots")),
        pl.DataFrame(all_positions, schema=_schema("positions")),
    )


def _schema(table: str) -> dict:
    from .store import SCHEMAS

    return SCHEMAS[table]
