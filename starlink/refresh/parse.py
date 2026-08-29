"""Parse Celestrak GP/OMM JSON or classic 3LE TLE into Sat records."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from refresh.orbit import altitude_km


@dataclass(frozen=True)
class Sat:
    name: str
    norad_id: int
    epoch: datetime
    inclination: float
    raan: float
    argp: float
    mean_anomaly: float
    ecc: float
    mean_motion: float
    altitude_km: float


def parse_omm_records(records: list[dict]) -> list[Sat]:
    sats: list[Sat] = []
    for rec in records:
        try:
            sats.append(_from_omm(rec))
        except (KeyError, TypeError, ValueError):
            continue
    return sats


def parse_tle_file(path: Path) -> list[Sat]:
    lines = [ln for ln in path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
    sats: list[Sat] = []
    i = 0
    while i < len(lines) - 2:
        name, line1, line2 = lines[i], lines[i + 1], lines[i + 2]
        if line1.startswith("1") and line2.startswith("2"):
            try:
                sats.append(_from_tle(name, line1, line2))
            except (ValueError, IndexError):
                pass
            i += 3
        else:
            i += 1
    return sats


def _from_omm(rec: dict) -> Sat:
    epoch = _parse_omm_epoch(str(rec["EPOCH"]))
    ecc = float(rec["ECCENTRICITY"])
    mm = float(rec["MEAN_MOTION"])
    return Sat(
        name=str(rec["OBJECT_NAME"]).strip(),
        norad_id=int(rec["NORAD_CAT_ID"]),
        epoch=epoch,
        inclination=float(rec["INCLINATION"]),
        raan=float(rec["RA_OF_ASC_NODE"]),
        argp=float(rec["ARG_OF_PERICENTER"]),
        mean_anomaly=float(rec["MEAN_ANOMALY"]),
        ecc=ecc,
        mean_motion=mm,
        altitude_km=altitude_km(mm, ecc),
    )


def _parse_omm_epoch(s: str) -> datetime:
    s = s.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt


def _from_tle(name: str, line1: str, line2: str) -> Sat:
    # Same field slices as Animation_vertical.Satellite (lines 114–176).
    name = name[1:].strip() if name.startswith("0") else name.strip()
    norad_id = int(line1[2:7].lstrip().rstrip())
    epoch_year = int(line1[18:20].lstrip().rstrip())
    epoch_day = float(line1[20:32].lstrip().rstrip())
    epoch = datetime(2000 + epoch_year, 1, 1) + timedelta(days=epoch_day - 1)
    ecc = float("0." + line2[26:33].lstrip().rstrip())
    mm = float(line2[52:63].lstrip().rstrip())
    return Sat(
        name=name,
        norad_id=norad_id,
        epoch=epoch,
        inclination=float(line2[8:16].lstrip().rstrip()),
        raan=float(line2[17:25].lstrip().rstrip()),
        argp=float(line2[34:42].lstrip().rstrip()),
        mean_anomaly=float(line2[43:51].lstrip().rstrip()),
        ecc=ecc,
        mean_motion=mm,
        altitude_km=altitude_km(mm, ecc),
    )
