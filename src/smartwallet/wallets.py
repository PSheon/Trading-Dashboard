"""The wallet registry. Wallets are added and never removed.

Dropping dead wallets would put survivorship bias straight into the data, so
every save checks that no address that was there before has gone missing, and
that nobody's `first_seen_at` has moved.
"""

import polars as pl

from .store import Warehouse, conform

DAY = 86_400
ACTIVE_DAYS = 30  # traded this recently → fetched daily
DORMANT_EVERY_DAYS = 7  # otherwise → fetched weekly
DAILY_MIN_GAP = 20 * 3600  # "daily" tolerates a cron that runs a bit early


class RegistryError(RuntimeError):
    pass


def load(wh: Warehouse) -> pl.DataFrame:
    return wh.read("wallets")


def _save(wh: Warehouse, before: pl.DataFrame, after: pl.DataFrame) -> None:
    after = conform(after, "wallets")
    lost = set(before["address"]) - set(after["address"])
    if lost:
        raise RegistryError(f"wallets are never removed; would lose {sorted(lost)[:5]}")
    moved = before.join(after, on="address", suffix="_after").filter(
        pl.col("first_seen_at") != pl.col("first_seen_at_after")
    )
    if len(moved):
        raise RegistryError(f"first_seen_at is fixed; changed for {moved['address'].to_list()[:5]}")
    wh.write("wallets", after.sort("first_seen_at", "address"))


def add(
    wh: Warehouse,
    addresses: list[str],
    *,
    discovered_via: str,
    now: int,
    discovered_from_token: str | None = None,
    funnel_run_id: str | None = None,
) -> list[str]:
    """Register addresses not yet known. Known ones are left exactly as they are."""
    before = load(wh)
    known = set(before["address"])
    fresh = list(dict.fromkeys(a for a in addresses if a not in known))
    if not fresh:
        return []
    new = conform(
        pl.DataFrame(
            {
                "address": fresh,
                "first_seen_at": [now] * len(fresh),
                "discovered_via": [discovered_via] * len(fresh),
                "discovered_from_token": [discovered_from_token] * len(fresh),
                "funnel_run_id": [funnel_run_id] * len(fresh),
            }
        ),
        "wallets",
    )
    _save(wh, before, pl.concat([before, new]))
    return fresh


def record_fetch(wh: Warehouse, fetched: dict[str, tuple[int | None, int, int]]) -> None:
    """Store {address: (newest block time seen, fetched at, fetched from)}."""
    before = load(wh)
    updates = pl.DataFrame(
        {
            "address": list(fetched),
            "_cursor": [v[0] for v in fetched.values()],
            "_fetched": [v[1] for v in fetched.values()],
            "_from": [v[2] for v in fetched.values()],
        },
        schema={"address": pl.Utf8, "_cursor": pl.Int64, "_fetched": pl.Int64, "_from": pl.Int64},
    )
    after = (
        before.join(updates, on="address", how="left")
        .with_columns(
            # A fetch that saw nothing new keeps the old cursor.
            fetch_cursor_time=pl.max_horizontal("fetch_cursor_time", "_cursor"),
            last_fetched_at=pl.coalesce("_fetched", "last_fetched_at"),
            history_from=pl.min_horizontal("history_from", "_from"),
        )
        .drop("_cursor", "_fetched", "_from")
    )
    _save(wh, before, after)


def due(registry: pl.DataFrame, now: int) -> list[str]:
    """Wallets whose next fetch is due: never fetched, active daily, dormant weekly."""
    active = pl.col("fetch_cursor_time") >= now - ACTIVE_DAYS * DAY
    since = now - pl.col("last_fetched_at")
    return registry.filter(
        pl.col("last_fetched_at").is_null()
        | (active & (since >= DAILY_MIN_GAP))
        | (~active.fill_null(False) & (since >= DORMANT_EVERY_DAYS * DAY))
    )["address"].to_list()
