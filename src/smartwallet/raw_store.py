"""Append-only store for raw API responses: one gzipped JSON line per response.

Nothing here is ever rewritten. Parsers read from these files, so a parser bug
is fixed by re-parsing, not by fetching again.
"""

import gzip
import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path


def append(path: Path, *, source: str, request_key: str, request: dict, response) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "source": source,
        "request_key": request_key,
        "fetched_at": datetime.now(UTC).isoformat(),
        "request": request,
        "response": response,
    }
    with gzip.open(path, "at", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")


def read(path: Path) -> Iterator[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)
