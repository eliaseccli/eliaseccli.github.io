"""Pack historical STLK v1 month bins from yearly Space-Track 2-line TLE files.

Clemens:

    PYTHONPATH=starlink TLE_DIR=/workspace/spacetrack-tles \\
        python3 -m refresh.pack_timeline --out /workspace/starlink-timeline/out-j2

Range is 2019-05-24 through the latest TLE day. Does not modify the TLE files.
Writes STATUS.txt year by year. New NORADs append to catalog.json; new tight
piles freeze into shell_refs.json after 5 stable days, then refine n/i/e
with a clock-level phase so x does not wrap. Last plot x/y go into
lock_state.json for same-day reuse and pile EMA; ox/oy stay 0.
Playback packing is 15 fps metadata;
one day per frame.

20%+ catalog wipeouts (sat count ≥20% below the 7-day neighbor median)
are dropped as real dumps: they do not assign clocks or advance `end`.
Play frames on those dates are shortest-arc interpolations of packed (x, y)
from the bounding real days, then a 3-day centered shortest-arc mean.
Does not fetch Space-Track. Does not write into the git tree unless --out
points there.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from collections import deque

from refresh.binary import DayFrame, MonthBin, write_month, ymd_int
from refresh.catalog import PLAYBACK_FPS, TimelineCatalog, write_manifest
from refresh.clocks import ShellRefs, assign_clocks
from refresh.lock import LockState, apply_locks
from refresh.j2 import T0, pack_u16
from refresh.parse import Sat, iter_tle_file
from refresh.wipeout import WipeoutGate, fill_v1_holes

DEFAULT_TLE_DIR = Path(os.environ.get("TLE_DIR", "/workspace/spacetrack-tles"))
START = date(2019, 5, 24)


def _closest_to_noon(existing: Sat | None, cand: Sat, noon: datetime) -> Sat:
    if existing is None:
        return cand
    if abs((cand.epoch - noon).total_seconds()) < abs((existing.epoch - noon).total_seconds()):
        return cand
    return existing


def _load_year(tle_dir: Path, year: int, start: date, end: date | None) -> dict[date, dict[int, Sat]]:
    path = tle_dir / f"starlink_{year}.tle"
    by_day: dict[date, dict[int, Sat]] = defaultdict(dict)
    if not path.exists():
        return by_day
    for sat in iter_tle_file(path):
        d = sat.epoch.date()
        if d < start:
            continue
        if end is not None and d > end:
            continue
        noon = datetime(d.year, d.month, d.day, 12, 0, 0)
        by_day[d][sat.norad_id] = _closest_to_noon(by_day[d].get(sat.norad_id), sat, noon)
    return by_day


def _merge_day(dst: dict[int, Sat], src: dict[int, Sat], d: date) -> None:
    noon = datetime(d.year, d.month, d.day, 12, 0, 0)
    for nid, sat in src.items():
        dst[nid] = _closest_to_noon(dst.get(nid), sat, noon)


def pack_timeline(
    tle_dir: Path,
    out_dir: Path,
    *,
    start: date = START,
    end: date | None = None,
) -> dict:
    tle_dir = Path(tle_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    v1 = out_dir / "v1"
    v1.mkdir(parents=True, exist_ok=True)
    status_path = out_dir / "STATUS.txt"

    years = []
    for p in sorted(tle_dir.glob("starlink_*.tle")):
        try:
            years.append(int(p.stem.split("_")[1]))
        except (IndexError, ValueError):
            continue
    if not years:
        raise SystemExit(f"no starlink_YYYY.tle files in {tle_dir}")

    catalog = TimelineCatalog(start=start.isoformat(), end=start.isoformat(), fps=PLAYBACK_FPS)
    refs = ShellRefs()
    lock_state = LockState()
    # Carry TLEs whose epoch year differs from the filename year.
    leftover: dict[date, dict[int, Sat]] = {}
    months_written: list[str] = []
    days_written = 0
    last_day: date | None = None
    pending_month: MonthBin | None = None
    pending_sats: deque[tuple[date, list[Sat]]] = deque()
    gate = WipeoutGate()
    wipeout_dates: list[date] = []

    def flush_month() -> None:
        nonlocal pending_month
        if pending_month is None or not pending_month.days:
            return
        ym = f"{pending_month.year:04d}-{pending_month.month:02d}"
        write_month(v1 / f"{ym}.bin", pending_month)
        if ym not in months_written:
            months_written.append(ym)
        pending_month = None

    def process_day(d: date, day_sats: list[Sat]) -> None:
        nonlocal pending_month, days_written, last_day
        if not day_sats:
            return
        for s in day_sats:
            catalog.append_sat(s)
        # Real dumps only: wipeout days never enter clock matching.
        clocks = assign_clocks(day_sats, refs, d.isoformat())
        t = datetime(d.year, d.month, d.day, 12, 0, 0)
        xy = apply_locks(day_sats, clocks, t, lock_state, d.isoformat())
        slots: list[int] = []
        xs: list[int] = []
        ys: list[int] = []
        for s in day_sats:
            slot = catalog.slot_of(s.norad_id)
            pos = xy.get(s.norad_id)
            if slot is None or pos is None:
                continue
            x, y = pos
            slots.append(slot)
            xs.append(pack_u16(x))
            ys.append(pack_u16(y))
        if pending_month is None or pending_month.year != d.year or pending_month.month != d.month:
            flush_month()
            pending_month = MonthBin(
                year=d.year,
                month=d.month,
                catalog_len=len(catalog.sats),
                first_date=ymd_int(d.year, d.month, d.day),
                days=[],
            )
        pending_month.catalog_len = len(catalog.sats)
        pending_month.days.append(
            DayFrame(
                date=ymd_int(d.year, d.month, d.day),
                flags=0,
                slots=slots,
                xs=xs,
                ys=ys,
            )
        )
        days_written += 1
        last_day = d
        catalog.end = d.isoformat()

    def feed_day(d: date, day_sats: list[Sat]) -> None:
        pending_sats.append((d, day_sats))
        gate.push(d, len(day_sats))
        _drain_gate(final=False)

    def _drain_gate(*, final: bool) -> None:
        for day, wiped in gate.drain(final=final):
            ds, ss = pending_sats.popleft()
            if ds != day:
                raise RuntimeError(f"wipeout gate desync: {ds} != {day}")
            if wiped:
                wipeout_dates.append(day)
                continue
            process_day(ds, ss)

    with status_path.open("w", encoding="utf-8") as status:
        status.write(f"t0={T0.isoformat()} start={start.isoformat()} tle_dir={tle_dir}\n")
        status.flush()
        for year in range(min(years), max(years) + 1):
            status.write(f"loading {year}...\n")
            status.flush()
            by_day = leftover
            leftover = {}
            loaded = _load_year(tle_dir, year, start, end)
            for d, mp in loaded.items():
                if d not in by_day:
                    by_day[d] = mp
                else:
                    _merge_day(by_day[d], mp, d)
            this_year = sorted(d for d in by_day if d.year == year and d >= start)
            leftover = {d: by_day[d] for d in by_day if d.year > year}
            n_before = days_written
            piles_before = len(refs.piles)
            cat_before = len(catalog.sats)
            for d in this_year:
                feed_day(d, list(by_day[d].values()))
            status.write(
                f"{year}: days={days_written - n_before} "
                f"catalog {cat_before}->{len(catalog.sats)} "
                f"piles {piles_before}->{len(refs.piles)}\n"
            )
            status.flush()
        extra = sorted(d for d in leftover if (end is None or d <= end) and d >= start)
        for d in extra:
            feed_day(d, list(leftover[d].values()))
        _drain_gate(final=True)
        flush_month()
        if last_day is None and not wipeout_dates:
            status.write("no TLE days in range\n")
            raise SystemExit("no TLE days in range")
        filled = fill_v1_holes(v1, extra_holes=wipeout_dates)
        if filled["last_real"]:
            catalog.end = filled["last_real"]
        days_written = filled["days"]
        months_written = filled["months"]
        catalog.save(out_dir / "catalog.json")
        refs.save(out_dir / "shell_refs.json")
        lock_state.save(out_dir / "lock_state.json")
        bytes_total = filled["bytes"]
        write_manifest(
            out_dir / "manifest.json",
            start=catalog.start,
            end=catalog.end,
            months=months_written,
            catalog=len(catalog.sats),
            days=days_written,
            bytes_total=bytes_total,
            synthetic=filled["synthetic"],
        )
        status.write(
            f"wipeouts={len(wipeout_dates)} synthetic={len(filled['synthetic'])}\n"
        )
        status.write(
            f"done end={catalog.end} days={days_written} "
            f"catalog={len(catalog.sats)} piles={len(refs.piles)} "
            f"bytes={bytes_total} fps={PLAYBACK_FPS}\n"
        )
        status.flush()

    return {
        "end": catalog.end,
        "days": days_written,
        "catalog": len(catalog.sats),
        "piles": len(refs.piles),
        "months": months_written,
        "synthetic": filled["synthetic"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="refresh.pack_timeline",
        description="Pack STLK v1 month bins from yearly starlink_YYYY.tle files (J2 pile-lock).",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Output directory (catalog.json, shell_refs.json, lock_state.json, manifest.json, v1/, STATUS.txt)",
    )
    parser.add_argument(
        "--tle-dir",
        default=str(DEFAULT_TLE_DIR),
        help="Directory of starlink_YYYY.tle (default: env TLE_DIR or /workspace/spacetrack-tles)",
    )
    parser.add_argument("--start", default=START.isoformat(), help="First frame date (YYYY-MM-DD)")
    parser.add_argument("--end", default="", help="Last frame date (default: latest TLE day)")
    args = parser.parse_args(argv)
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end) if args.end else None
    info = pack_timeline(Path(args.tle_dir), Path(args.out), start=start, end=end)
    print(
        f"packed {info['days']} days, catalog {info['catalog']}, "
        f"piles {info['piles']}, end {info['end']} -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    if __package__ is None:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    sys.exit(main())
