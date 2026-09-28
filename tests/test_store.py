import polars as pl

from smartwallet.store import Warehouse, conform

JAN = 1_704_067_200  # 2024-01-01
FEB = 1_706_745_600  # 2024-02-01


def trade(wallet, sig, block_time, amount=1):
    return {
        "tx_sig": sig,
        "wallet": wallet,
        "mint": "M",
        "side": "buy",
        "token_amount_raw": amount,
        "slot": block_time,
        "block_time": block_time,
    }


def test_scan_of_missing_table_is_empty_with_schema(tmp_path):
    df = Warehouse(tmp_path).read("trades")
    assert df.is_empty()
    assert df.schema["token_amount_raw"] == pl.Int64


def test_monthly_table_splits_by_block_time_month(tmp_path):
    wh = Warehouse(tmp_path)
    wh.replace_wallets(
        "trades", ["A"], pl.DataFrame([trade("A", "s1", JAN), trade("A", "s2", FEB)])
    )
    assert [f.name for f in wh.files("trades")] == [
        "month=2024-01.parquet",
        "month=2024-02.parquet",
    ]
    assert wh.read("trades")["tx_sig"].sort().to_list() == ["s1", "s2"]


def test_replace_wallets_drops_rows_no_longer_emitted_and_keeps_others(tmp_path):
    wh = Warehouse(tmp_path)
    wh.replace_wallets(
        "trades",
        ["A", "B"],
        pl.DataFrame([trade("A", "a1", JAN), trade("A", "a2", FEB), trade("B", "b1", JAN)]),
    )
    # A re-ingested: a2 is gone, a1 changed.
    wh.replace_wallets("trades", ["A"], pl.DataFrame([trade("A", "a1", JAN, amount=5)]))
    rows = wh.read("trades").sort("tx_sig")
    assert rows.select("tx_sig", "token_amount_raw").rows() == [("a1", 5), ("b1", 1)]


def test_single_file_table_replace(tmp_path):
    wh = Warehouse(tmp_path)
    lots = [{"wallet": w, "mint": "M", "lot_seq": 0} for w in ("A", "B")]
    wh.replace_wallets("lots", ["A", "B"], pl.DataFrame(lots))
    wh.replace_wallets("lots", ["A"], pl.DataFrame(schema={"wallet": pl.Utf8}))
    assert wh.read("lots")["wallet"].to_list() == ["B"]


def test_conform_orders_columns_and_fills_missing():
    df = conform(pl.DataFrame({"wallet": ["A"], "tx_sig": ["s"]}), "trades")
    assert df.columns[:3] == ["tx_sig", "wallet", "mint"]
    assert df["mint"].to_list() == [None]
