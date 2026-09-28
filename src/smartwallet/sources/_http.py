import time

import httpx

RETRY_STATUS = {429, 500, 502, 503, 504}


def send(client: httpx.Client, method: str, url: str, *, attempts: int = 5, **kwargs):
    """Send with exponential backoff on rate limits and server errors."""
    for attempt in range(attempts):
        resp = client.request(method, url, **kwargs)
        if resp.status_code not in RETRY_STATUS or attempt == attempts - 1:
            resp.raise_for_status()
            return resp.json()
        retry_after = resp.headers.get("retry-after")
        time.sleep(float(retry_after) if retry_after else 2**attempt)
    raise AssertionError("unreachable")
