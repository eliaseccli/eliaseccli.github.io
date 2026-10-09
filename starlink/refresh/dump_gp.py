"""Slim Celestrak GP JSON for the Look up sky page.

Keeps SGP4 fields only. Starlink from the daily GP cache (or a file);
ISS (ZARYA, 25544) from a stations list when present. Does not fetch
Space-Track.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from refresh.fetch import fetch_gp_json, fetch_stations_json, gp_cache

ISS_NORAD = 25544
USER_AGENT = "eliaseccli-lookup/1.0 (https://eliaseccli.com/projects/lookup/)"

# Compact row: name, norad, epoch, n, e, i, raan, argp, m, bstar, nDot, kind
KIND_STARLINK = "sl"
KIND_ISS = "iss"


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


def _previous_iss_row(out_path: Path) -> list | None:
    """Slim ISS row already published in gp.json, if any."""
    path = Path(out_path)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        return None
    sats = payload.get("sats") if isinstance(payload, dict) else None
    if not isinstance(sats, list):
        return None
    for row in sats:
        if isinstance(row, list) and len(row) >= 3 and row[-1] == KIND_ISS:
            return row
    return None


def dump_gp(
    out_path: Path,
    *,
    starlink_path: Path | None = None,
    stations_path: Path | None = None,
    fetch_missing: bool = True,
) -> dict:
    sl_path = starlink_path if starlink_path is not None else gp_cache()
    starlink = _load_records(sl_path)
    if not starlink and fetch_missing:
        # Same source list as `refresh fetch`. Do not start a second long
        # retry loop against only the HTTPS URL.
        fetched = fetch_gp_json()
        if fetched:
            starlink = [r for r in fetched if isinstance(r, dict)]

    stations = _load_records(stations_path)
    if not stations and fetch_missing:
        fetched = fetch_stations_json(user_agent=USER_AGENT)
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

    iss_row = None
    iss_rec = pick_iss(stations)
    if iss_rec is not None:
        iss_row = slim_record(iss_rec, KIND_ISS)
    if iss_row is None and fetch_missing and not stations:
        # Stations host timed out. Keep the ISS row already in gp.json.
        iss_row = _previous_iss_row(out_path)
        if iss_row is not None:
            print("stations GP unavailable, kept previous ISS", flush=True)
    if iss_row is not None:
        rows = [r for r in rows if r[1] != iss_row[1]]
        rows.append(iss_row)

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
