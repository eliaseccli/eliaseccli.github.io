"""Celestrak GP JSON fetch. One GET, no retry on failure."""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

GP_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json"
CACHE_DIR = Path(os.environ.get("STARLINK_CACHE", "/tmp/starlink-refresh"))
GP_CACHE = CACHE_DIR / "starlink_gp.json"


@dataclass(frozen=True)
class Catalog:
    kind: str
    path: Path
    records: list | None
    note: str


def load_catalog() -> Catalog:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fetched = _fetch_gp_once()
    if fetched is None:
        raise SystemExit("Celestrak GP JSON fetch failed; not retrying")
    GP_CACHE.write_text(json.dumps(fetched), encoding="utf-8")
    return Catalog("json", GP_CACHE, fetched, "GP JSON downloaded from Celestrak")


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _fetch_gp_once() -> list | None:
    req = urllib.request.Request(
        GP_URL,
        headers={"User-Agent": "eliaseccli-starlink-refresh/1.0 (https://eliaseccli.com/starlink)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45, context=_ssl_context()) as resp:
            if getattr(resp, "status", 200) != 200:
                print(f"GP JSON fetch: HTTP {getattr(resp, 'status', '?')}, not retrying")
                return None
            body = resp.read()
    except urllib.error.HTTPError as exc:
        print(f"GP JSON fetch: HTTP {exc.code}, not retrying")
        return None
    except Exception as exc:
        print(f"GP JSON fetch failed ({type(exc).__name__}: {exc}), not retrying")
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        print("GP JSON fetch: body is not JSON, not retrying")
        return None
    if not isinstance(data, list):
        print("GP JSON fetch: JSON is not a list, not retrying")
        return None
    return data
