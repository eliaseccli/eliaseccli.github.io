"""Append (or rebuild) today's timeline day from an already-fetched GP JSON."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from refresh.binary import DayFrame, MonthBin, read_month, upsert_day, write_month, ymd_int
from refresh.catalog import TimelineCatalog
from refresh.clocks import ShellRefs, assign_clocks
from refresh.fetch import GP_CACHE, load_catalog
from refresh.j2 import pack_u16
from refresh.lock import LockState, apply_locks
from refresh.parse import Sat, parse_omm_records, parse_tle_file
from refresh.wipeout import apply_hole_fill, today_is_wipeout


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
    across daily Action runs. Matched piles refine n/i/e and absorb the
    wrap into x0/y0; clump phase persists. Last plot x,y persist in
    lock_state.json for same-day reuse and pile EMA; ox/oy stay 0. A day
    whose sat count is ≥50% below the 7-day neighbor median is a wipeout:
    clocks are not assigned, catalog.end does not advance, and a synthetic
    frame is interpolated (or held) instead. Does not fetch Space-Track.
    Raises TimelineSkip if the catalog or v1 directory is missing.
    """
    timeline_dir = Path(timeline_dir)
    catalog_path = timeline_dir / "catalog.json"
    refs_path = timeline_dir / "shell_refs.json"
    lock_path = timeline_dir / "lock_state.json"
    v1_dir = timeline_dir / "v1"
    if not catalog_path.exists() or not v1_dir.exists():
        raise TimelineSkip("timeline catalog or v1/ missing")

    sats = _load_gp(gp_path)
    day = frame_date or _utc_today()
    day_s = day.isoformat()
    catalog = TimelineCatalog.load(catalog_path)
    refs = ShellRefs.load(refs_path)
    lock_state = LockState.load(lock_path)

    if today_is_wipeout(v1_dir, day, len(sats)):
        # Broken dump: do not clock-match, do not add NORADs, do not
        # advance catalog/manifest end. Insert a synthetic hold so the
        # next real day can lerp across the hole.
        filled = apply_hole_fill(timeline_dir, extra_holes=[day])
        return {
            "date": day_s,
            "n": 0,
            "catalog": len(catalog.sats),
            "piles": len(refs.piles),
            "pending": len(refs.pending),
            "month": str(v1_dir / f"{day.year:04d}-{day.month:02d}.bin"),
            "wipeout": True,
            "synthetic": filled["synthetic"],
            "end": filled["last_real"] or catalog.end,
        }

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

    # Re-lerp any synthetic holes now that today is a new real bound.
    filled = apply_hole_fill(timeline_dir)
    catalog = TimelineCatalog.load(catalog_path)
    return {
        "date": day_s,
        "n": len(slots),
        "catalog": len(catalog.sats),
        "piles": len(refs.piles),
        "pending": len(refs.pending),
        "month": str(month_path),
        "wipeout": False,
        "synthetic": filled["synthetic"],
        "end": catalog.end,
    }
