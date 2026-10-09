"""Celestrak GP JSON fetch.

HTTPS to celestrak.org often never answers from GitHub-hosted (Azure) runners
and other datacenter IPs: the socket sits until timeout (run 37930040788,
five 60s attempts, twice). The same GP query over HTTP on that host returns
the OMM JSON. Try the documented HTTPS URL first, then HTTP, then the
supplemental GP file. One download per process is written to STARLINK_CACHE
so later steps reuse it.

Timeouts are per socket idle gap, not the whole transfer, so a slow stream
can finish while a dead source gives up quickly.
"""

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
# Same catalog, different scheme/path. HTTPS is canonical; HTTP is the mirror
# that still answers when 443 is black-holed. Supplemental is operator OMM
# (same fields) if the standard group query is down. No Space-Track.
GP_URLS = (
    GP_URL,
    "http://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json",
    "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json",
    "http://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json",
)
STATIONS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json"
STATIONS_URLS = (
    STATIONS_URL,
    "http://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json",
)

USER_AGENT = "eliaseccli-starlink-refresh/1.0 (https://eliaseccli.com/starlink)"

# Primary source: one retry. Fallbacks: a single attempt. Dead sockets must
# not burn minutes (previously 5 x 60s, twice per job).
FETCH_ATTEMPTS = 2
FALLBACK_ATTEMPTS = 1
FETCH_TIMEOUT_S = 20
BACKOFF_S = (2,)

# Below this many complete OMM rows, do not replace the published catalog.
MIN_STARLINK_RECORDS = 1000
REQUIRED_OMM = (
    "NORAD_CAT_ID",
    "OBJECT_NAME",
    "EPOCH",
    "MEAN_MOTION",
    "ECCENTRICITY",
    "INCLINATION",
    "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER",
    "MEAN_ANOMALY",
)

# Workflow maps this to a green job that leaves committed files alone.
EXIT_NO_FRESH = 3


@dataclass(frozen=True)
class Catalog:
    kind: str
    path: Path
    records: list | None
    note: str


def cache_dir() -> Path:
    return Path(os.environ.get("STARLINK_CACHE", "/tmp/starlink-refresh"))


def gp_cache() -> Path:
    return cache_dir() / "starlink_gp.json"


def gp_source_urls() -> tuple[str, ...]:
    raw = os.environ.get("STARLINK_GP_URLS", "").strip()
    if raw:
        return tuple(u.strip() for u in raw.split(",") if u.strip())
    return GP_URLS


def stations_source_urls() -> tuple[str, ...]:
    raw = os.environ.get("STARLINK_STATIONS_URLS", "").strip()
    if raw:
        return tuple(u.strip() for u in raw.split(",") if u.strip())
    return STATIONS_URLS


def _min_records() -> int:
    raw = os.environ.get("STARLINK_MIN_RECORDS", "").strip()
    if raw:
        return max(1, int(raw))
    return MIN_STARLINK_RECORDS


def _timeout_s() -> float:
    raw = os.environ.get("STARLINK_FETCH_TIMEOUT", "").strip()
    if raw:
        return float(raw)
    return float(FETCH_TIMEOUT_S)


def _primary_attempts() -> int:
    raw = os.environ.get("STARLINK_FETCH_ATTEMPTS", "").strip()
    if raw:
        return max(1, int(raw))
    return FETCH_ATTEMPTS


def _log(msg: str) -> None:
    print(msg, flush=True)


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _retryable_http(code: int) -> bool:
    return code in (408, 425, 429, 500, 502, 503, 504)


def _source_label(url: str) -> str:
    scheme = "https" if url.lower().startswith("https:") else "http"
    if "sup-gp.php" in url:
        kind = "sup-gp"
    elif "GROUP=stations" in url or "group=stations" in url.lower():
        kind = "stations"
    else:
        kind = "gp"
    return f"{scheme} {kind}"


def _count_usable(data: list) -> int:
    good = 0
    for rec in data:
        if not isinstance(rec, dict):
            continue
        if all(rec.get(key) not in (None, "") for key in REQUIRED_OMM):
            good += 1
    return good


def _write_json_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _write_gp_cache(records: list) -> Path:
    path = gp_cache()
    _write_json_atomic(path, json.dumps(records, separators=(",", ":")))
    return path


def read_gp_cache() -> list | None:
    """Return the cached GP list, or None if there is no cache file.

    A present file that is not a JSON list is corrupt data: fail, do not
    pretend the cache is missing and hit the network.
    """
    path = gp_cache()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"corrupt GP cache: {path}: {exc}") from exc
    if not isinstance(data, list):
        raise SystemExit(f"corrupt GP cache: {path}: JSON is not a list")
    return data


def fetch_json_list(
    url: str,
    *,
    user_agent: str = USER_AGENT,
    attempts: int | None = None,
    timeout: float | None = None,
) -> list | None:
    """GET a JSON list. None means this URL did not yield one."""
    n_attempts = _primary_attempts() if attempts is None else attempts
    timeout_s = _timeout_s() if timeout is None else timeout
    label = _source_label(url)
    last_note = ""
    for attempt in range(1, n_attempts + 1):
        req = urllib.request.Request(url, headers={"User-Agent": user_agent})
        kwargs: dict = {"timeout": timeout_s}
        if url.lower().startswith("https:"):
            kwargs["context"] = _ssl_context()
        try:
            with urllib.request.urlopen(req, **kwargs) as resp:
                status = getattr(resp, "status", 200)
                if status != 200:
                    last_note = f"HTTP {status}"
                    if _retryable_http(status) and attempt < n_attempts:
                        _log(
                            f"GP JSON fetch attempt {attempt}/{n_attempts} ({label}): "
                            f"{last_note}, retrying"
                        )
                        _sleep_backoff(attempt)
                        continue
                    _log(f"GP JSON fetch ({label}): {last_note}, giving up")
                    return None
                body = resp.read()
        except urllib.error.HTTPError as exc:
            last_note = f"HTTP {exc.code}"
            if _retryable_http(exc.code) and attempt < n_attempts:
                _log(
                    f"GP JSON fetch attempt {attempt}/{n_attempts} ({label}): "
                    f"{last_note}, retrying"
                )
                _sleep_backoff(attempt)
                continue
            _log(f"GP JSON fetch ({label}): {last_note}, giving up")
            return None
        except Exception as exc:
            last_note = f"{type(exc).__name__}: {exc}"
            if attempt < n_attempts:
                _log(
                    f"GP JSON fetch attempt {attempt}/{n_attempts} ({label}): "
                    f"{last_note}, retrying"
                )
                _sleep_backoff(attempt)
                continue
            _log(f"GP JSON fetch failed ({label}, {last_note}), giving up")
            return None

        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            last_note = "body is not JSON"
            if attempt < n_attempts:
                _log(
                    f"GP JSON fetch attempt {attempt}/{n_attempts} ({label}): "
                    f"{last_note}, retrying"
                )
                _sleep_backoff(attempt)
                continue
            _log(f"GP JSON fetch ({label}): {last_note}, giving up")
            return None
        if not isinstance(data, list):
            _log(f"GP JSON fetch ({label}): JSON is not a list, giving up")
            return None
        if attempt > 1:
            _log(f"GP JSON fetch ok on attempt {attempt}/{n_attempts} ({label})")
        return data

    _log(f"GP JSON fetch failed after retries ({label}, {last_note})")
    return None


def fetch_gp_json() -> list | None:
    """First usable Starlink catalog from the source list.

    Returns None when every source is unreachable or too small to publish.
    Raises SystemExit when a source answered with a non-empty JSON list that
    has no OMM rows (corrupt / unexpected schema).
    """
    urls = gp_source_urls()
    schema_broken = False
    floor = _min_records()
    for index, url in enumerate(urls):
        attempts = _primary_attempts() if index == 0 else FALLBACK_ATTEMPTS
        data = fetch_json_list(url, attempts=attempts)
        if data is None:
            if index + 1 < len(urls):
                _log(f"GP source failed ({_source_label(url)}), trying next")
            continue
        good = _count_usable(data)
        if good >= floor:
            _log(f"GP JSON fetched from {url} ({good} records)")
            return data
        if len(data) > 0 and good == 0:
            schema_broken = True
            _log(
                f"GP JSON from {url} is not OMM "
                f"({len(data)} records, 0 usable)"
            )
        else:
            _log(
                f"GP JSON from {url} is too small to publish "
                f"({good} usable, need {floor})"
            )
        if index + 1 < len(urls):
            _log("trying next GP source")
    if schema_broken:
        raise SystemExit("corrupt GP JSON: records are not OMM")
    return None


def fetch_stations_json(*, user_agent: str = USER_AGENT) -> list | None:
    """ISS/stations list. One attempt per URL; failure is non-fatal."""
    urls = stations_source_urls()
    for index, url in enumerate(urls):
        data = fetch_json_list(url, user_agent=user_agent, attempts=1)
        if data:
            _log(f"stations GP fetched from {url} ({len(data)} records)")
            return data
        if index + 1 < len(urls):
            _log(f"stations source failed ({_source_label(url)}), trying next")
    return None


def load_catalog() -> Catalog:
    fetched = fetch_gp_json()
    if fetched is None:
        raise SystemExit("Celestrak GP JSON fetch failed after retries")
    path = _write_gp_cache(fetched)
    return Catalog("json", path, fetched, "GP JSON downloaded from Celestrak")


def fetch_and_cache(cache_copy: Path | None = None) -> int:
    """Download once into STARLINK_CACHE. EXIT_NO_FRESH if nothing usable.

    Does not read an older cache in place of a failed download: publishing
    yesterday's elements would advance the timeline and skip later retries.
    """
    fetched = fetch_gp_json()
    if fetched is None:
        _log("no fresh data today, kept previous")
        return EXIT_NO_FRESH
    path = _write_gp_cache(fetched)
    if cache_copy is not None:
        _write_json_atomic(cache_copy, path.read_text(encoding="utf-8"))
        _log(f"cached {len(fetched)} GP records -> {path} (copy {cache_copy})")
    else:
        _log(f"cached {len(fetched)} GP records -> {path}")
    return 0


def _sleep_backoff(attempt: int) -> None:
    # attempt is 1-based index of the attempt that just failed.
    if not BACKOFF_S:
        return
    idx = min(max(attempt - 1, 0), len(BACKOFF_S) - 1)
    base = BACKOFF_S[idx]
    delay = base + random.uniform(0, min(0.5, base * 0.25))
    time.sleep(delay)


# Back-compat for callers/tests that imported the old private name.
def _fetch_gp_once() -> list | None:
    return fetch_gp_json()
