from smartwallet.fifo import Event, run_fifo

SOL = 1_000_000_000


def ev(t, kind, amount, sol=None, sig=None):
    signed = amount if kind in ("buy", "transfer_in") else -amount
    return Event(tx_sig=sig or f"s{t}", slot=t, block_time=t, kind=kind, amount=signed, sol=sol)


def closed(lots):
    return [lot for lot in lots if lot.close_type is not None]


def test_round_trip_is_one_position_with_realized_pnl():
    lots, [pos] = run_fifo("W", "M", [ev(10, "buy", 100, SOL), ev(20, "sell", 100, 3 * SOL)])
    [lot] = lots
    assert (lot.close_type, lot.cost_lamports, lot.proceeds_lamports) == ("sell", SOL, 3 * SOL)
    assert (lot.realized_pnl_lamports, lot.hold_seconds) == (2 * SOL, 10)
    assert (pos.opened_at, pos.closed_at, pos.realized_pnl_lamports) == (10, 20, 2 * SOL)
    assert pos.complete


def test_partial_sells_split_lots_but_stay_one_position():
    lots, [pos] = run_fifo(
        "W",
        "M",
        [ev(1, "buy", 100, SOL), ev(2, "sell", 30, SOL), ev(3, "sell", 70, 2 * SOL)],
    )
    assert [(lot.token_amount_raw, lot.cost_lamports) for lot in lots] == [
        (30, 300_000_000),
        (70, 700_000_000),
    ]
    assert pos.lots == 2
    assert pos.realized_pnl_lamports == 3 * SOL - SOL


def test_fifo_consumes_oldest_lot_first():
    lots, _ = run_fifo(
        "W",
        "M",
        [ev(1, "buy", 10, 10), ev(2, "buy", 10, 20), ev(3, "sell", 15, 45)],
    )
    done = closed(lots)
    assert [(lot.buy_tx_sig, lot.token_amount_raw, lot.cost_lamports) for lot in done] == [
        ("s1", 10, 10),
        ("s2", 5, 10),
    ]
    # Proceeds split by amount and add up exactly.
    assert [lot.proceeds_lamports for lot in done] == [30, 15]
    [still_open] = [lot for lot in lots if lot.close_type is None]
    assert (still_open.token_amount_raw, still_open.cost_lamports) == (5, 10)


def test_integer_cost_split_never_loses_a_lamport():
    lots, [pos] = run_fifo(
        "W",
        "M",
        [ev(1, "buy", 3, 100), ev(2, "sell", 1, 50), ev(3, "sell", 1, 50), ev(4, "sell", 1, 50)],
    )
    assert sum(lot.cost_lamports for lot in lots) == 100
    assert pos.cost_lamports == 100


def test_selling_back_to_zero_then_buying_again_starts_a_new_position():
    _, positions = run_fifo(
        "W",
        "M",
        [ev(1, "buy", 10, 10), ev(2, "sell", 10, 20), ev(3, "buy", 5, 5), ev(4, "sell", 5, 1)],
    )
    assert [
        (p.position_seq, p.opened_at, p.closed_at, p.realized_pnl_lamports) for p in positions
    ] == [(0, 1, 2, 10), (1, 3, 4, -4)]


def test_open_position_has_no_close_and_no_pnl():
    lots, [pos] = run_fifo("W", "M", [ev(1, "buy", 10, 10)])
    assert pos.closed_at is None and pos.realized_pnl_lamports is None and not pos.complete
    assert lots[0].close_type is None


def test_transfer_out_closes_lots_without_pnl_and_marks_position_incomplete():
    lots, [pos] = run_fifo("W", "M", [ev(1, "buy", 10, 10), ev(2, "transfer_out", 10)])
    assert (lots[0].close_type, lots[0].realized_pnl_lamports) == ("transfer_out", None)
    assert pos.has_transfer_out and not pos.complete
    assert pos.realized_pnl_lamports is None


def test_tokens_received_by_transfer_have_unknown_cost():
    lots, [pos] = run_fifo("W", "M", [ev(1, "transfer_in", 10), ev(2, "sell", 10, 50)])
    assert lots[0].cost_unknown and lots[0].realized_pnl_lamports is None
    assert lots[0].proceeds_lamports == 50
    assert pos.has_unknown_cost and not pos.complete


def test_selling_more_than_held_creates_an_orphan_lot_for_the_excess():
    lots, [pos] = run_fifo("W", "M", [ev(1, "buy", 10, 10), ev(2, "sell", 15, 30)])
    known, orphan = lots
    assert (known.token_amount_raw, known.proceeds_lamports, known.cost_unknown) == (10, 20, False)
    assert (orphan.token_amount_raw, orphan.proceeds_lamports) == (5, 10)
    assert orphan.cost_unknown and orphan.buy_tx_sig is None and orphan.hold_seconds is None
    assert pos.closed_at == 2 and pos.has_unknown_cost


def test_sell_with_no_holdings_at_all_is_its_own_closed_position():
    lots, [pos] = run_fifo("W", "M", [ev(5, "sell", 10, 30)])
    assert lots[0].cost_unknown
    assert (pos.opened_at, pos.closed_at, pos.complete) == (5, 5, False)


def test_dust_left_after_selling_is_written_off_and_closes_the_position():
    lots, positions = run_fifo(
        "W",
        "M",
        [ev(1, "buy", 100_000, 1000), ev(2, "sell", 99_999, 2000), ev(3, "buy", 10, 10)],
        dust_ratio=0.001,
    )
    first, second = positions
    assert first.closed_at == 2 and first.complete
    dust = [lot for lot in lots if lot.close_type == "dust"]
    assert [(d.token_amount_raw, d.proceeds_lamports, d.close_time) for d in dust] == [(1, 0, 2)]
    # The dust's cost is a loss inside the first position.
    assert first.realized_pnl_lamports == 2000 - 1000
    assert second.opened_at == 3


def test_buy_with_unknown_sol_leg_is_cost_unknown():
    lots, [pos] = run_fifo("W", "M", [ev(1, "buy", 10, None), ev(2, "sell", 10, 50)])
    assert lots[0].cost_unknown and not pos.complete


def test_sell_with_unknown_proceeds_leaves_position_incomplete():
    lots, [pos] = run_fifo("W", "M", [ev(1, "buy", 10, 10), ev(2, "sell", 10, None)])
    assert lots[0].proceeds_lamports is None and lots[0].realized_pnl_lamports is None
    assert not pos.complete


def test_lot_seq_is_unique_even_when_one_buy_is_sold_in_pieces():
    lots, _ = run_fifo(
        "W",
        "M",
        [
            ev(1, "buy", 10, 10),
            ev(2, "sell", 3, 5),
            ev(3, "sell", 3, 5),
            ev(4, "buy", 1, 1),
            ev(5, "sell", 5, 5),
            ev(6, "buy", 2, 2),
        ],
    )
    assert [lot.lot_seq for lot in lots] == list(range(len(lots)))


def test_same_input_gives_same_output():
    events = [
        ev(1, "buy", 7, 13),
        ev(2, "sell", 3, 11),
        ev(3, "transfer_in", 2),
        ev(4, "sell", 6, 9),
    ]
    assert run_fifo("W", "M", events) == run_fifo("W", "M", list(events))
