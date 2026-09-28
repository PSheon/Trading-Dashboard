import polars as pl
import pytest

from smartwallet import wallets
from smartwallet.store import Warehouse

DAY = 86_400
NOW = 1_800_000_000


def test_add_registers_new_and_leaves_known_untouched(tmp_path):
    wh = Warehouse(tmp_path)
    assert wallets.add(wh, ["A", "B", "A"], discovered_via="manual", now=NOW) == ["A", "B"]
    assert wallets.add(wh, ["B", "C"], discovered_via="token_funnel", now=NOW + DAY) == ["C"]
    reg = wallets.load(wh).sort("address")
    assert reg.select("address", "first_seen_at", "discovered_via").rows() == [
        ("A", NOW, "manual"),
        ("B", NOW, "manual"),
        ("C", NOW + DAY, "token_funnel"),
    ]


def test_saving_a_registry_that_lost_a_wallet_is_refused(tmp_path):
    wh = Warehouse(tmp_path)
    wallets.add(wh, ["A", "B"], discovered_via="manual", now=NOW)
    before = wallets.load(wh)
    with pytest.raises(wallets.RegistryError, match="never removed"):
        wallets._save(wh, before, before.filter(pl.col("address") == "A"))
    with pytest.raises(wallets.RegistryError, match="first_seen_at"):
        wallets._save(wh, before, before.with_columns(first_seen_at=pl.lit(0)))
    assert len(wallets.load(wh)) == 2


def test_record_fetch_keeps_cursor_when_nothing_new_and_history_start_earliest(tmp_path):
    wh = Warehouse(tmp_path)
    wallets.add(wh, ["A"], discovered_via="manual", now=NOW)
    wallets.record_fetch(wh, {"A": (NOW - 100, NOW, NOW - 180 * DAY)})
    wallets.record_fetch(wh, {"A": (None, NOW + DAY, NOW - 700)})
    [r] = wallets.load(wh).to_dicts()
    assert (r["fetch_cursor_time"], r["last_fetched_at"]) == (NOW - 100, NOW + DAY)
    assert r["history_from"] == NOW - 180 * DAY


def test_due_fetches_active_daily_and_dormant_weekly():
    reg = pl.DataFrame(
        {
            "address": ["new", "active_recent", "active_stale", "dormant_recent", "dormant_stale"],
            "fetch_cursor_time": [None, NOW - DAY, NOW - DAY, NOW - 60 * DAY, NOW - 60 * DAY],
            "last_fetched_at": [None, NOW - 3600, NOW - DAY, NOW - 3 * DAY, NOW - 8 * DAY],
        }
    )
    assert wallets.due(reg, NOW) == ["new", "active_stale", "dormant_stale"]
