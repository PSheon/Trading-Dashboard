import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    helius_api_key: str | None
    dune_api_key: str | None
    data_dir: Path


def load() -> Settings:
    load_dotenv(ROOT / ".env")
    return Settings(
        helius_api_key=os.getenv("HELIUS_API_KEY") or None,
        dune_api_key=os.getenv("DUNE_API_KEY") or None,
        data_dir=Path(os.getenv("DATA_DIR") or ROOT / "data"),
    )


def require(value: str | None, name: str) -> str:
    if not value:
        raise SystemExit(f"{name} is not set; add it to .env (see .env.example)")
    return value
