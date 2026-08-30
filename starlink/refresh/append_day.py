"""Append (or rebuild) today's timeline day from an already-fetched GP JSON."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from refresh.binary import DayFrame, MonthBin, read_month, upsert_day, write_month, ymd_int
from refresh.catalog import TimelineCatalog, write_manifest
from refresh.clocks import ShellRefs, assign_clocks
from refresh.fetch import GP_CACHE, load_catalog
from refresh.j2 import pack_u16
from refresh.lock import LockState, apply_locks
from refresh.parse import Sat, parse_omm_records, parse_tle_file


class TimelineSkip(Exception):
    """Required timeline files are missing; sats.json dump should still succeed."""


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


def _load_gp(gp_path: Path | None) -> list[Sat]:
    path = gp_path or GP_CACHE
    if not path.exists():
        if gp_path is not None:
            raise TimelineSkip(f"GP JSON cache missing: {path}")
        try:
            catalog = load_catalog()
        except SystemExit as exc:
            raise TimelineSkip(str(exc)) from exc
        if catalog.kind == "json":
            sats = parse_omm_records(catalog.records or [])
        else:
            sats = parse_tle_file(catalog.path)
        if not sats:
            raise TimelineSkip("no satellites parsed")
        return sats
    rec = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rec, list):
        raise TimelineSkip("GP JSON is not a list")
    sats = parse_omm_records(rec)
    if not sats:
        raise TimelineSkip("no satellites parsed from GP JSON")
    return sats


def append_today(
    timeline_dir: Path,
    *,
    gp_path: Path | None = None,
    frame_date: date | None = None,
) -> dict:
    """Write today's J2-locked frame into the current month bin.

    Loads catalog.json, shell_refs.json, lock_state.json, and the current
    YYYY-MM.bin when present. New NORADs append to the catalog. Pending
    tight-pile streaks persist in shell_refs.json so a freeze can finish
    across daily Action runs; frozen (n, i, e) are never edited. Per-sat
    offsets and last plot x,y persist in lock_state.json. Does not fetch
    Space-Track. Raises TimelineSkip if the catalog or v1 directory is missing.
    """
    timeline_dir = Path(timeline_dir)
    catalog_path = timeline_dir / "catalog.json"
    refs_path = timeline_dir / "shell_refs.json"
    lock_path = timeline_dir / "lock_state.json"
    manifest_path = timeline_dir / "manifest.json"
    v1_dir = timeline_dir / "v1"
    if not catalog_path.exists() or not v1_dir.exists():
        raise TimelineSkip("timeline catalog or v1/ missing")

    sats = _load_gp(gp_path)
    day = frame_date or _utc_today()
    day_s = day.isoformat()
    catalog = TimelineCatalog.load(catalog_path)
    refs = ShellRefs.load(refs_path)
    lock_state = LockState.load(lock_path)

    for s in sats:
        catalog.append_sat(s)
    clocks = assign_clocks(sats, refs, day_s)
    t = datetime(day.year, day.month, day.day, 12, 0, 0)
    xy = apply_locks(sats, clocks, t, lock_state, day_s)

    slots: list[int] = []
    xs: list[int] = []
    ys: list[int] = []
    for s in sats:
        slot = catalog.slot_of(s.norad_id)
        pos = xy.get(s.norad_id)
        if slot is None or pos is None:
            continue
        x, y = pos
        slots.append(slot)
        xs.append(pack_u16(x))
        ys.append(pack_u16(y))

    ym = f"{day.year:04d}-{day.month:02d}"
    month_path = v1_dir / f"{ym}.bin"
    if month_path.exists():
        month = read_month(month_path)
    else:
        month = MonthBin(
            year=day.year,
            month=day.month,
            catalog_len=len(catalog.sats),
            first_date=ymd_int(day.year, day.month, day.day),
            days=[],
        )
    frame = DayFrame(
        date=ymd_int(day.year, day.month, day.day),
        flags=0,
        slots=slots,
        xs=xs,
        ys=ys,
    )
    upsert_day(month, frame, len(catalog.sats))
    write_month(month_path, month)

    if catalog.end < day_s:
        catalog.end = day_s
    catalog.save(catalog_path)
    refs.save(refs_path)
    lock_state.save(lock_path)

    months = sorted({p.stem for p in v1_dir.glob("*.bin")})
    days_n = 0
    bytes_total = 0
    for p in v1_dir.glob("*.bin"):
        bytes_total += p.stat().st_size
        try:
            days_n += len(read_month(p).days)
        except ValueError:
            continue
    write_manifest(
        manifest_path,
        start=catalog.start,
        end=catalog.end,
        months=months,
        catalog=len(catalog.sats),
        days=days_n,
        bytes_total=bytes_total,
    )
    return {
        "date": day_s,
        "n": len(slots),
        "catalog": len(catalog.sats),
        "piles": len(refs.piles),
        "pending": len(refs.pending),
        "month": str(month_path),
    }
