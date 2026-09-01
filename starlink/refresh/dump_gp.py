"""Slim Celestrak GP JSON for the Look up sky page.

Keeps SGP4 fields only. Starlink from the daily GP cache (or a file);
ISS (ZARYA, 25544) from a stations list when present. Does not fetch
Space-Track.
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from refresh.fetch import GP_CACHE

STATIONS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json"
ISS_NORAD = 25544
USER_AGENT = "eliaseccli-lookup/1.0 (https://eliaseccli.com/projects/lookup/)"

# Compact row: name, norad, epoch, n, e, i, raan, argp, m, bstar, nDot, kind
KIND_STARLINK = "sl"
KIND_ISS = "iss"


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _fetch_json_list(url: str) -> list | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=45, context=_ssl_context()) as resp:
            if getattr(resp, "status", 200) != 200:
                print(f"GP fetch: HTTP {getattr(resp, 'status', '?')} {url}")
                return None
            body = resp.read()
    except urllib.error.HTTPError as exc:
        print(f"GP fetch: HTTP {exc.code} {url}")
        return None
    except Exception as exc:
        print(f"GP fetch failed ({type(exc).__name__}: {exc}) {url}")
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        print("GP fetch: body is not JSON")
        return None
    if not isinstance(data, list):
        print("GP fetch: JSON is not a list")
        return None
    return data


def _load_records(path: Path | None) -> list[dict]:
    if path is None or not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"GP JSON is not a list: {path}")
    return [r for r in data if isinstance(r, dict)]


def _num(rec: dict, key: str, default: float = 0.0) -> float:
    try:
        return float(rec.get(key) if rec.get(key) is not None else default)
    except (TypeError, ValueError):
        return default


def slim_record(rec: dict, kind: str = KIND_STARLINK) -> list | None:
    try:
        norad = int(rec["NORAD_CAT_ID"])
        epoch = str(rec["EPOCH"]).strip()
        mm = float(rec["MEAN_MOTION"])
        ecc = float(rec["ECCENTRICITY"])
        inc = float(rec["INCLINATION"])
        raan = float(rec["RA_OF_ASC_NODE"])
        argp = float(rec["ARG_OF_PERICENTER"])
        ma = float(rec["MEAN_ANOMALY"])
    except (KeyError, TypeError, ValueError):
        return None
    name = str(rec.get("OBJECT_NAME") or f"SAT-{norad}").strip()
    return [
        name,
        norad,
        epoch,
        round(mm, 8),
        round(ecc, 8),
        round(inc, 4),
        round(raan, 4),
        round(argp, 4),
        round(ma, 4),
        _num(rec, "BSTAR"),
        _num(rec, "MEAN_MOTION_DOT"),
        kind,
    ]


def pick_iss(records: list[dict]) -> dict | None:
    zarya = None
    by_id = None
    for rec in records:
        try:
            nid = int(rec.get("NORAD_CAT_ID"))
        except (TypeError, ValueError):
            continue
        name = str(rec.get("OBJECT_NAME") or "")
        if nid == ISS_NORAD:
            by_id = rec
            if "ZARYA" in name.upper():
                zarya = rec
                break
    return zarya or by_id


def dump_gp(
    out_path: Path,
    *,
    starlink_path: Path | None = None,
    stations_path: Path | None = None,
    fetch_missing: bool = True,
) -> dict:
    sl_path = starlink_path if starlink_path is not None else GP_CACHE
    starlink = _load_records(sl_path)
    if not starlink and fetch_missing:
        from refresh.fetch import GP_URL
        fetched = _fetch_json_list(GP_URL)
        if fetched:
            starlink = [r for r in fetched if isinstance(r, dict)]

    stations = _load_records(stations_path)
    if not stations and fetch_missing:
        fetched = _fetch_json_list(STATIONS_URL)
        if fetched:
            stations = [r for r in fetched if isinstance(r, dict)]

    rows: list[list] = []
    seen: set[int] = set()
    for rec in starlink:
        row = slim_record(rec, KIND_STARLINK)
        if row is None or row[1] in seen:
            continue
        seen.add(row[1])
        rows.append(row)

    iss_rec = pick_iss(stations)
    if iss_rec is not None:
        row = slim_record(iss_rec, KIND_ISS)
        if row is not None:
            # Prefer the stations ISS row over a Starlink collision (none).
            rows = [r for r in rows if r[1] != row[1]]
            rows.append(row)

    if not rows:
        raise SystemExit("no GP records to dump")

    epochs = [r[2] for r in rows if r[2]]
    payload = {
        "source": "Celestrak GP JSON",
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "epoch": max(epochs) if epochs else "",
        "n": len(rows),
        "sats": rows,
    }
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return payload
