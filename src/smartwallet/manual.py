"""Human-authored data: notes. It cannot be rebuilt from raw, so it lives in
SQLite beside the warehouse, never inside a table a rebuild would replace.
Back this file up.
"""

import sqlite3
import time
from pathlib import Path


class Notes:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as c:
            c.execute(
                "CREATE TABLE IF NOT EXISTS wallet_notes ("
                " address TEXT PRIMARY KEY, note TEXT NOT NULL, updated_at INTEGER NOT NULL)"
            )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=10)

    def all(self) -> dict[str, dict]:
        with self._connect() as c:
            rows = c.execute("SELECT address, note, updated_at FROM wallet_notes").fetchall()
        return {a: {"note": n, "updated_at": t} for a, n, t in rows}

    def get(self, address: str) -> dict | None:
        return self.all().get(address)

    def set(self, address: str, note: str, *, now: int | None = None) -> dict:
        now = int(time.time()) if now is None else now
        note = note.strip()
        with self._connect() as c:
            if note:
                c.execute(
                    "INSERT INTO wallet_notes (address, note, updated_at) VALUES (?, ?, ?)"
                    " ON CONFLICT(address) DO UPDATE SET note = excluded.note,"
                    " updated_at = excluded.updated_at",
                    (address, note, now),
                )
            else:
                c.execute("DELETE FROM wallet_notes WHERE address = ?", (address,))
        return {"note": note, "updated_at": now}
