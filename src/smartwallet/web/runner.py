"""Runs the daily job in a background thread, one at a time, on demand or on a
daily UTC schedule. The web process is the only writer when this is used, so
there is a single replica and no cron beside it.
"""

import logging
import threading
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

log = logging.getLogger(__name__)


class JobRunner:
    def __init__(self, job: Callable[[], dict]):
        self._job = job
        self._lock = threading.Lock()
        self.state: dict = {
            "running": False,
            "started_at": None,
            "finished_at": None,
            "result": None,
            "error": None,
            "next_scheduled_at": None,
        }

    def start(self) -> bool:
        """Start the job unless one is running. Returns whether it started."""
        if not self._lock.acquire(blocking=False):
            return False
        self.state |= {"running": True, "started_at": int(time.time()), "error": None}
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def _run(self) -> None:
        try:
            self.state["result"] = self._job()
        except Exception:
            self.state["error"] = traceback.format_exc(limit=5)
            log.exception("daily job failed")
        finally:
            self.state |= {"running": False, "finished_at": int(time.time())}
            self._lock.release()

    def schedule_daily(self, hhmm: str) -> None:
        """Run every day at HH:MM UTC."""
        hour, minute = (int(x) for x in hhmm.split(":"))

        def loop() -> None:
            while True:
                now = datetime.now(UTC)
                nxt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                if nxt <= now:
                    nxt += timedelta(days=1)
                self.state["next_scheduled_at"] = int(nxt.timestamp())
                time.sleep((nxt - now).total_seconds())
                if not self.start():
                    log.warning("scheduled run skipped: a run is already in progress")

        threading.Thread(target=loop, daemon=True).start()
