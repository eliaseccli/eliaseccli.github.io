"""Parse Celestrak GP/OMM JSON or classic 2LE/3LE TLE into Sat records."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterator

from refresh.orbit import altitude_km

# Alpha-5: A=10 … Z=33, skip I and O (24 letters).
_ALPHA5 = "ABCDEFGHJKLMNPQRSTUVWXYZ"


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


def parse_norad_id(field: str) -> int:
    """Decode a 5-column TLE / Alpha-5 NORAD catalog number."""
    field = field.strip().upper()
    if not field:
        raise ValueError("empty NORAD field")
    if field[0].isdigit():
        return int(field)
    letter = field[0]
    if letter not in _ALPHA5:
        raise ValueError(f"bad Alpha-5 letter {letter!r}")
    rest = field[1:]
    if rest and not rest.isdigit():
        raise ValueError(f"bad Alpha-5 digits {field!r}")
    return (10 + _ALPHA5.index(letter)) * 10000 + int(rest or "0")


def parse_tle_file(path: Path) -> list[Sat]:
    return list(iter_tle_file(path))


def iter_tle_file(path: Path) -> Iterator[Sat]:
    """Yield sats from a 2LE or 3LE file. Does not modify the file."""
    name_hold: str | None = None
    line1: str | None = None
    with path.open(encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            ln = raw.rstrip("\n\r")
            if not ln.strip():
                continue
            if _is_tle_line(ln, "1"):
                line1 = ln
            elif _is_tle_line(ln, "2") and line1 is not None:
                try:
                    yield _from_tle(name_hold or "", line1, ln)
                except (ValueError, IndexError):
                    pass
                name_hold = None
                line1 = None
            else:
                name_hold = ln
                line1 = None


def _is_tle_line(ln: str, num: str) -> bool:
    return ln.startswith(num) and (len(ln) < 2 or ln[1] in " ")


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
    norad_id = parse_norad_id(line1[2:7])
    if not name:
        name = f"STARLINK-{norad_id}"
    epoch_year = int(line1[18:20].lstrip().rstrip())
    epoch_day = float(line1[20:32].lstrip().rstrip())
    century = 1900 if epoch_year >= 57 else 2000
    epoch = datetime(century + epoch_year, 1, 1) + timedelta(days=epoch_day - 1)
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
