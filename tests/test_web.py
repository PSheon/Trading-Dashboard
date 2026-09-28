from datetime import date

import polars as pl
import pytest
from fastapi.testclient import TestClient

from smartwallet import wallets
from smartwallet.config import Settings
from smartwallet.store import Warehouse, conform
from smartwallet.web.app import create_app

A = "BsLpMtNsSfrzdRHuVzwR1mCtFfjCAD63sZD4TkXPCvc9"
B = "KxErGmznc7HQmMYpcHKDXFsNrVJH8bv3NoqPenj4Pcd"
DAY = date(2026, 9, 28)


@pytest.fixture
def data_dir(tmp_path):
    wh = Warehouse(tmp_path / "warehouse")
    wallets.add(wh, [A, B], discovered_via="manual", now=1_790_000_000)
    wh.write_day(
        "wallet_metrics_daily",
        DAY,
        conform(
            pl.DataFrame({"as_of_date": [DAY], "wallet": [A], "trade_count": [42]}),
            "wallet_metrics_daily",
        ),
    )
    return tmp_path


def client(data_dir, password=None):
    settings = Settings(helius_api_key=None, dune_api_key=None, data_dir=data_dir)
    return TestClient(create_app(settings, password=password))


def test_list_includes_wallets_without_a_snapshot(data_dir):
    c = client(data_dir)
    assert c.get("/api/dates").json() == ["2026-09-28"]
    body = c.get("/api/wallets").json()
    assert body["as_of_date"] == "2026-09-28"
    by = {r["wallet"]: r for r in body["wallets"]}
    assert by[A]["trade_count"] == 42
    assert by[B]["trade_count"] is None  # registered, no metrics yet, still listed


def test_note_round_trip_and_unknown_wallet(data_dir):
    c = client(data_dir)
    assert (
        c.put(f"/api/wallets/{A}/note", json={"note": " fast exits "}).json()["note"]
        == "fast exits"
    )
    assert c.get(f"/api/wallets/{A}").json()["note"] == "fast exits"
    rows = {r["wallet"]: r for r in c.get("/api/wallets").json()["wallets"]}
    assert rows[A]["note"] == "fast exits"
    assert c.put("/api/wallets/nope/note", json={"note": "x"}).status_code == 404
    assert c.get("/api/wallets/nope").status_code == 404


def test_wallet_detail_shapes(data_dir):
    d = client(data_dir).get(f"/api/wallets/{A}").json()
    assert d["wallet"]["address"] == A
    assert [m["trade_count"] for m in d["metrics"]] == [42]
    assert d["positions"] == [] and d["trades"] == [] and d["transfers"] == []


def test_add_wallets_validates_addresses(data_dir):
    c = client(data_dir)
    new = "5W3p4yq8Dh1DQqfA4wRER4tUT1jUwprXkExaexTE15rs"
    res = c.post(
        "/api/wallets", json={"addresses": f"{new}\n{A}, {new}", "via": "public_leaderboard"}
    )
    assert res.json() == {"added": [new], "already_known": 1}
    assert c.post("/api/wallets", json={"addresses": "not-an-address"}).status_code == 422
    assert c.post("/api/wallets", json={"addresses": new, "via": "bogus"}).status_code == 422


def test_password_guards_everything_but_health(data_dir):
    c = client(data_dir, password="s3cret")
    assert c.get("/api/health").status_code == 200
    for path in ("/", "/wallet", "/api/wallets", "/api/dates", "/api/jobs"):
        assert c.get(path).status_code == 401, path
    assert c.get("/api/wallets", auth=("paul", "wrong")).status_code == 401
    assert c.get("/api/wallets", auth=("paul", "s3cret")).status_code == 200


def test_pages_are_served(data_dir):
    c = client(data_dir)
    assert "Smart wallets" in c.get("/").text
    assert "Round trips" in c.get("/wallet").text
    assert c.get("/static/common.js").status_code == 200
