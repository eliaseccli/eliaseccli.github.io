"""Celestrak GP JSON fetch. Retries with backoff on timeouts and transient errors."""

from __future__ import annotations

import json
import os
import random
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

GP_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json"
CACHE_DIR = Path(os.environ.get("STARLINK_CACHE", "/tmp/starlink-refresh"))
GP_CACHE = CACHE_DIR / "starlink_gp.json"
USER_AGENT = "eliaseccli-starlink-refresh/1.0 (https://eliaseccli.com/starlink)"

# One attempt + retries. Timeout is per attempt (large GP JSON can be slow).
FETCH_ATTEMPTS = 5
FETCH_TIMEOUT_S = 60
# Backoff before attempts 2..5 (seconds), plus a little jitter.
BACKOFF_S = (5, 15, 30, 60)


@dataclass(frozen=True)
class Catalog:
    kind: str
    path: Path
    records: list | None
    note: str


def load_catalog() -> Catalog:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fetched = fetch_gp_json()
    if fetched is None:
        raise SystemExit("Celestrak GP JSON fetch failed after retries")
    GP_CACHE.write_text(json.dumps(fetched), encoding="utf-8")
    return Catalog("json", GP_CACHE, fetched, "GP JSON downloaded from Celestrak")


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _retryable_http(code: int) -> bool:
    return code in (408, 425, 429, 500, 502, 503, 504)


def fetch_json_list(url: str, *, user_agent: str = USER_AGENT) -> list | None:
    """GET a JSON list from Celestrak (or similar), with retries."""
    last_note = ""
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        req = urllib.request.Request(url, headers={"User-Agent": user_agent})
        try:
            with urllib.request.urlopen(
                req, timeout=FETCH_TIMEOUT_S, context=_ssl_context()
            ) as resp:
                status = getattr(resp, "status", 200)
                if status != 200:
                    last_note = f"HTTP {status}"
                    if _retryable_http(status) and attempt < FETCH_ATTEMPTS:
                        print(f"GP JSON fetch attempt {attempt}/{FETCH_ATTEMPTS}: {last_note}, retrying")
                        _sleep_backoff(attempt)
                        continue
                    print(f"GP JSON fetch: {last_note}, giving up")
                    return None
                body = resp.read()
        except urllib.error.HTTPError as exc:
            last_note = f"HTTP {exc.code}"
            if _retryable_http(exc.code) and attempt < FETCH_ATTEMPTS:
                print(f"GP JSON fetch attempt {attempt}/{FETCH_ATTEMPTS}: {last_note}, retrying")
                _sleep_backoff(attempt)
                continue
            print(f"GP JSON fetch: {last_note}, giving up")
            return None
        except Exception as exc:
            last_note = f"{type(exc).__name__}: {exc}"
            if attempt < FETCH_ATTEMPTS:
                print(f"GP JSON fetch attempt {attempt}/{FETCH_ATTEMPTS}: {last_note}, retrying")
                _sleep_backoff(attempt)
                continue
            print(f"GP JSON fetch failed ({last_note}), giving up")
            return None

        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            last_note = "body is not JSON"
            if attempt < FETCH_ATTEMPTS:
                print(f"GP JSON fetch attempt {attempt}/{FETCH_ATTEMPTS}: {last_note}, retrying")
                _sleep_backoff(attempt)
                continue
            print(f"GP JSON fetch: {last_note}, giving up")
            return None
        if not isinstance(data, list):
            print("GP JSON fetch: JSON is not a list, giving up")
            return None
        if attempt > 1:
            print(f"GP JSON fetch ok on attempt {attempt}/{FETCH_ATTEMPTS}")
        return data

    print(f"GP JSON fetch failed after retries ({last_note})")
    return None


def fetch_gp_json() -> list | None:
    return fetch_json_list(GP_URL)


def _sleep_backoff(attempt: int) -> None:
    # attempt is 1-based index of the attempt that just failed.
    idx = min(max(attempt - 1, 0), len(BACKOFF_S) - 1)
    base = BACKOFF_S[idx]
    delay = base + random.uniform(0, min(5.0, base * 0.25))
    time.sleep(delay)


# Back-compat for callers/tests that imported the old private name.
def _fetch_gp_once() -> list | None:
    return fetch_gp_json()
