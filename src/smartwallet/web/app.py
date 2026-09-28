"""The dashboard: a JSON API over the warehouse plus two static pages.

Reads go straight to the Parquet files (in-memory, read-only), so the daily job
can write while the page is open. Notes are the only thing the page writes to
the database, and they go to SQLite.
"""

import os
import re
import secrets
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Annotated

import polars as pl
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import config, jobs, wallets
from ..manual import Notes
from ..sources.helius import HeliusClient
from ..store import Warehouse
from .runner import JobRunner

STATIC = Path(__file__).parent / "static"
ADDRESS = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
VIA = ("token_funnel", "public_leaderboard", "manual")
TRADE_COLUMNS = [
    "tx_sig",
    "mint",
    "side",
    "token_amount_raw",
    "decimals",
    "sol_lamports",
    "fee_lamports",
    "price_sol",
    "price_confidence",
    "block_time",
]


class NoteIn(BaseModel):
    note: str


class WalletsIn(BaseModel):
    addresses: str
    via: str = "manual"


def create_app(
    settings: config.Settings | None = None,
    *,
    password: str | None = None,
    helius_factory: Callable[[], HeliusClient] | None = None,
    schedule_utc: str | None = None,
) -> FastAPI:
    settings = settings or config.load()
    password = password if password is not None else os.getenv("APP_PASSWORD") or None
    wh = Warehouse(settings.data_dir / "warehouse")
    raw_dir = settings.data_dir / "raw"
    notes = Notes(settings.data_dir / "manual.sqlite")

    def make_helius() -> HeliusClient:
        if helius_factory:
            return helius_factory()
        return HeliusClient(config.require(settings.helius_api_key, "HELIUS_API_KEY"))

    runner = JobRunner(lambda: jobs.daily(wh, make_helius(), raw_dir, now=int(time.time())))
    if schedule_utc:
        runner.schedule_daily(schedule_utc)

    basic = HTTPBasic(auto_error=False)

    def auth(creds: Annotated[HTTPBasicCredentials | None, Depends(basic)]) -> None:
        if password is None:
            return
        ok = creds is not None and secrets.compare_digest(
            creds.password.encode(), password.encode()
        )
        if not ok:
            raise HTTPException(401, "password required", {"WWW-Authenticate": "Basic"})

    app = FastAPI(title="Smart wallets", docs_url=None, redoc_url=None)
    app.state.runner = runner

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    guarded = [Depends(auth)]

    @app.get("/api/dates", dependencies=guarded)
    def dates() -> list[date]:
        return sorted(wh.days("wallet_metrics_daily"), reverse=True)

    @app.get("/api/wallets", dependencies=guarded)
    def list_wallets(as_of: date | None = None) -> dict:
        days = wh.days("wallet_metrics_daily")
        day = as_of or (max(days) if days else None)
        registry = wallets.load(wh).rename({"address": "wallet"})
        if day in days:
            metrics = pl.read_parquet(
                wh.path("wallet_metrics_daily") / f"as_of_date={day.isoformat()}.parquet"
            ).drop("as_of_date")
            rows = registry.join(metrics, on="wallet", how="left")
        else:
            rows = registry
        all_notes = notes.all()
        out = rows.to_dicts()
        for r in out:
            r["note"] = (all_notes.get(r["wallet"]) or {}).get("note", "")
        return {"as_of_date": day, "wallets": out}

    @app.get("/api/wallets/{address}", dependencies=guarded)
    def wallet_detail(address: str) -> dict:
        registry = wallets.load(wh).filter(pl.col("address") == address)
        if registry.is_empty():
            raise HTTPException(404, "unknown wallet")

        def rows(table: str, *, sort: str, columns: list[str] | None = None) -> list[dict]:
            lf = wh.scan(table).filter(pl.col("wallet") == address)
            if columns:
                lf = lf.select(columns)
            return lf.sort(sort, descending=True, nulls_last=True).collect().to_dicts()

        return {
            "wallet": registry.to_dicts()[0],
            "note": (notes.get(address) or {}).get("note", ""),
            "metrics": wh.scan("wallet_metrics_daily")
            .filter(pl.col("wallet") == address)
            .sort("as_of_date")
            .collect()
            .to_dicts(),
            "positions": rows("positions", sort="opened_at"),
            "trades": rows("trades", sort="block_time", columns=TRADE_COLUMNS),
            "transfers": rows("token_transfers", sort="block_time"),
        }

    @app.put("/api/wallets/{address}/note", dependencies=guarded)
    def put_note(address: str, body: NoteIn) -> dict:
        if wallets.load(wh).filter(pl.col("address") == address).is_empty():
            raise HTTPException(404, "unknown wallet")
        return notes.set(address, body.note)

    @app.post("/api/wallets", dependencies=guarded)
    def add_wallets(body: WalletsIn) -> dict:
        if body.via not in VIA:
            raise HTTPException(422, f"via must be one of {VIA}")
        candidates = [a for a in re.split(r"[\s,]+", body.addresses) if a]
        invalid = [a for a in candidates if not ADDRESS.match(a)]
        if invalid:
            raise HTTPException(422, f"not Solana addresses: {invalid[:5]}")
        added = wallets.add(wh, candidates, discovered_via=body.via, now=int(time.time()))
        return {"added": added, "already_known": len(set(candidates)) - len(added)}

    @app.get("/api/jobs", dependencies=guarded)
    def job_state() -> dict:
        return runner.state

    @app.post("/api/jobs/daily", dependencies=guarded)
    def run_daily() -> dict:
        if not runner.start():
            raise HTTPException(409, "a run is already in progress")
        return runner.state

    @app.get("/", dependencies=guarded, include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/wallet", dependencies=guarded, include_in_schema=False)
    def wallet_page(request: Request) -> FileResponse:
        return FileResponse(STATIC / "wallet.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
