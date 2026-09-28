import sys
from datetime import UTC, datetime
from pathlib import Path

from smartwallet import config

SETTINGS = config.load()
P0_DIR = SETTINGS.data_dir / "p0"
RAW_DIR = SETTINGS.data_dir / "raw"
WALLETS_FILE = P0_DIR / "wallets.txt"


def read_wallets(path: Path = WALLETS_FILE) -> list[str]:
    if not path.exists():
        sys.exit(f"{path} not found; run pick_wallets.py or write one address per line")
    lines = (line.split("#")[0].strip() for line in path.read_text().splitlines())
    return [line for line in lines if line]


def run_stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def latest(directory: Path, pattern: str = "*.jsonl.gz") -> Path | None:
    files = sorted(directory.glob(pattern))
    return files[-1] if files else None
