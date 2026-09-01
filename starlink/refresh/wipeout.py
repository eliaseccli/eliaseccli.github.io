"""50%+ catalog wipeouts: drop as real dumps and interpolate packed (x, y).

A day is a wipeout when its sat count (set bits in that day's catalog bitmask)
is ≥50% below the median of a 7-day centered window of *neighboring* days.
The window does not wrap, and the day itself is not in the baseline (no
circular self-hit). Same definition as the irregular-days scan (85 days at
≥10%, 21 at ≥50% on the packed series).

Wipeout days are not real catalogs: they do not advance `end`, do not run
shell-clock matching, and do not add NORAD IDs. Play still gets a frame:
slots that exist on both bounding real days are shortest-arc lerped (x and y
are 360°). One-sided sats are omitted (packed bins have no alpha). Do not
invent slots.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from statistics import median
from typing import Iterable

from refresh.binary import DayFrame, MonthBin, read_month, upsert_day, write_month, ymd_int
from refresh.catalog import TimelineCatalog, write_manifest
from refresh.j2 import pack_u16, unpack_u16
from refresh.lock import shortest_delta, wrap360

FLAG_SYNTHETIC = 0x01
WINDOW_HALF = 3  # 7-day centered window: 3 neighbors each side + self
DROP_FRAC = 0.50


def is_synthetic(flags: int) -> bool:
    return bool(flags & FLAG_SYNTHETIC)


def ymd_to_date(ymd: int) -> date:
    return date(ymd // 10000, (ymd // 100) % 100, ymd % 100)


def date_to_ymd(d: date) -> int:
    return ymd_int(d.year, d.month, d.day)


def ymd_to_iso(ymd: int) -> str:
    return ymd_to_date(ymd).isoformat()


def neighbor_median(
    counts: list[int],
    index: int,
    half: int = WINDOW_HALF,
) -> float | None:
    """Median of a centered window excluding self. No circular wrap."""
    n = len(counts)
    if n < 2 or index < 0 or index >= n:
        return None
    lo = max(0, index - half)
    hi = min(n, index + half + 1)
    neigh = [counts[j] for j in range(lo, hi) if j != index]
    if not neigh:
        return None
    return float(median(neigh))


def is_wipeout(n: int, baseline: float | None, drop_frac: float = DROP_FRAC) -> bool:
    """True when n is ≥ drop_frac below the neighbor median."""
    if baseline is None or baseline <= 0:
        return False
    return n <= (1.0 - drop_frac) * baseline


def wipeout_mask(
    counts: list[int],
    *,
    drop_frac: float = DROP_FRAC,
    half: int = WINDOW_HALF,
) -> list[bool]:
    return [
        is_wipeout(n, neighbor_median(counts, i, half=half), drop_frac)
        for i, n in enumerate(counts)
    ]


class WipeoutGate:
    """Streaming detector: push (date, n), drain days whose +3 lookahead is in."""

    def __init__(self, *, drop_frac: float = DROP_FRAC, half: int = WINDOW_HALF) -> None:
        self.drop_frac = drop_frac
        self.half = half
        self._dates: list[date] = []
        self._counts: list[int] = []
        self._emitted = 0

    def push(self, d: date, n: int) -> None:
        self._dates.append(d)
        self._counts.append(int(n))

    def drain(self, final: bool = False) -> list[tuple[date, bool]]:
        out: list[tuple[date, bool]] = []
        while self._emitted < len(self._counts):
            i = self._emitted
            if not final and i + self.half >= len(self._counts):
                break
            med = neighbor_median(self._counts, i, half=self.half)
            out.append((self._dates[i], is_wipeout(self._counts[i], med, self.drop_frac)))
            self._emitted += 1
        return out


def lerp_angle(a: float, b: float, t: float) -> float:
    """Shortest-arc lerp on a 360° wrap."""
    return wrap360(a + shortest_delta(a, b) * t)


def interpolate_frame(before: DayFrame, after: DayFrame, hole_ymd: int) -> DayFrame:
    """Lerp slots present on both sides. FLAG_SYNTHETIC. No new slots."""
    dt_b = ymd_to_date(before.date)
    dt_a = ymd_to_date(after.date)
    dt_h = ymd_to_date(hole_ymd)
    span = (dt_a - dt_b).days
    t = 0.0 if span <= 0 else (dt_h - dt_b).days / span
    pos_b = {s: (x, y) for s, x, y in zip(before.slots, before.xs, before.ys)}
    pos_a = {s: (x, y) for s, x, y in zip(after.slots, after.xs, after.ys)}
    slots: list[int] = []
    xs: list[int] = []
    ys: list[int] = []
    for slot in sorted(set(pos_b) & set(pos_a)):
        xb, yb = pos_b[slot]
        xa, ya = pos_a[slot]
        slots.append(slot)
        xs.append(pack_u16(lerp_angle(unpack_u16(xb), unpack_u16(xa), t)))
        ys.append(pack_u16(lerp_angle(unpack_u16(yb), unpack_u16(ya), t)))
    return DayFrame(date=hole_ymd, flags=FLAG_SYNTHETIC, slots=slots, xs=xs, ys=ys)


def hold_frame(src: DayFrame, hole_ymd: int) -> DayFrame:
    """Trailing hole: copy last real positions until the next real dump arrives."""
    return DayFrame(
        date=hole_ymd,
        flags=FLAG_SYNTHETIC,
        slots=list(src.slots),
        xs=list(src.xs),
        ys=list(src.ys),
    )


def empty_synthetic(hole_ymd: int) -> DayFrame:
    return DayFrame(date=hole_ymd, flags=FLAG_SYNTHETIC, slots=[], xs=[], ys=[])


def load_months(v1_dir: Path) -> dict[str, MonthBin]:
    months: dict[str, MonthBin] = {}
    if not v1_dir.exists():
        return months
    for path in sorted(v1_dir.glob("*.bin")):
        try:
            months[path.stem] = read_month(path)
        except ValueError:
            continue
    return months


def flatten_frames(months: dict[str, MonthBin]) -> list[DayFrame]:
    days: list[DayFrame] = []
    for month in months.values():
        days.extend(month.days)
    days.sort(key=lambda d: d.date)
    return days


def last_real_frame(frames: Iterable[DayFrame], *, on_or_before: int | None = None) -> DayFrame | None:
    best: DayFrame | None = None
    for frame in frames:
        if is_synthetic(frame.flags):
            continue
        if on_or_before is not None and frame.date > on_or_before:
            continue
        if best is None or frame.date > best.date:
            best = frame
    return best


def fill_v1_holes(
    v1_dir: Path,
    *,
    extra_holes: Iterable[date] | None = None,
) -> dict:
    """Replace/insert synthetic frames for wipeouts and extra hole dates.

    Detection uses each day's current sat count (set bits). Existing
    FLAG_SYNTHETIC days are always re-filled. Does not invent calendar days
    that were never a dump unless listed in extra_holes.
    """
    v1_dir = Path(v1_dir)
    months = load_months(v1_dir)
    ordered = flatten_frames(months)
    if not ordered and not extra_holes:
        return {
            "synthetic": [],
            "last_real": None,
            "days": 0,
            "bytes": 0,
            "months": [],
            "rewritten": [],
        }

    counts = [len(f.slots) for f in ordered]
    mask = wipeout_mask(counts)
    holes: set[int] = set()
    for frame, wo in zip(ordered, mask):
        if wo or is_synthetic(frame.flags):
            holes.add(frame.date)
    for d in extra_holes or []:
        holes.add(date_to_ymd(d))

    reals = [f for f in ordered if f.date not in holes]
    all_ymds = sorted(set(f.date for f in ordered) | holes)

    filled: dict[int, DayFrame] = {}
    for ymd in all_ymds:
        if ymd not in holes:
            src = next(f for f in ordered if f.date == ymd)
            filled[ymd] = src
            continue
        before = next((f for f in reversed(reals) if f.date < ymd), None)
        after = next((f for f in reals if f.date > ymd), None)
        if before is not None and after is not None:
            filled[ymd] = interpolate_frame(before, after, ymd)
        elif before is not None:
            filled[ymd] = hold_frame(before, ymd)
        else:
            filled[ymd] = empty_synthetic(ymd)

    rewritten: list[str] = []
    by_ym: dict[str, list[DayFrame]] = {}
    for ymd, frame in filled.items():
        d = ymd_to_date(ymd)
        ym = f"{d.year:04d}-{d.month:02d}"
        by_ym.setdefault(ym, []).append(frame)

    for ym, days in by_ym.items():
        days.sort(key=lambda f: f.date)
        old = months.get(ym)
        catalog_len = old.catalog_len if old is not None else 0
        catalog_len = max(catalog_len, max((max(f.slots, default=-1) + 1) for f in days))
        if old is not None and old.days == days and old.catalog_len == catalog_len:
            continue
        y, m = int(ym[:4]), int(ym[5:7])
        month = MonthBin(
            year=y,
            month=m,
            catalog_len=catalog_len,
            first_date=days[0].date,
            days=days,
        )
        write_month(v1_dir / f"{ym}.bin", month)
        months[ym] = month
        rewritten.append(ym)

    last = last_real_frame(filled.values())
    synthetic = [ymd_to_iso(y) for y in sorted(holes)]
    month_names = sorted(months)
    bytes_total = sum(p.stat().st_size for p in v1_dir.glob("*.bin")) if v1_dir.exists() else 0
    return {
        "synthetic": synthetic,
        "last_real": ymd_to_iso(last.date) if last is not None else None,
        "days": sum(len(m.days) for m in months.values()),
        "bytes": bytes_total,
        "months": month_names,
        "rewritten": rewritten,
    }


def apply_hole_fill(
    timeline_dir: Path,
    *,
    extra_holes: Iterable[date] | None = None,
) -> dict:
    """Fill v1/ holes and point catalog/manifest `end` at the last real dump."""
    timeline_dir = Path(timeline_dir)
    v1 = timeline_dir / "v1"
    info = fill_v1_holes(v1, extra_holes=extra_holes)
    catalog_path = timeline_dir / "catalog.json"
    if catalog_path.exists() and info["last_real"]:
        catalog = TimelineCatalog.load(catalog_path)
        catalog.end = info["last_real"]
        catalog.save(catalog_path)
        write_manifest(
            timeline_dir / "manifest.json",
            start=catalog.start,
            end=catalog.end,
            months=info["months"],
            catalog=len(catalog.sats),
            days=info["days"],
            bytes_total=info["bytes"],
            synthetic=info["synthetic"],
        )
    return info


def today_is_wipeout(
    v1_dir: Path,
    today: date,
    n: int,
    *,
    drop_frac: float = DROP_FRAC,
) -> bool:
    """True when today's sat count trips the 50% neighbor-median rule."""
    frames = [f for f in flatten_frames(load_months(v1_dir)) if not is_synthetic(f.flags)]
    today_ymd = date_to_ymd(today)
    dates: list[int] = []
    counts: list[int] = []
    seen = False
    for frame in frames:
        if frame.date == today_ymd:
            dates.append(today_ymd)
            counts.append(n)
            seen = True
        else:
            dates.append(frame.date)
            counts.append(len(frame.slots))
    if not seen:
        # Keep date order.
        i = 0
        while i < len(dates) and dates[i] < today_ymd:
            i += 1
        dates.insert(i, today_ymd)
        counts.insert(i, n)
    idx = dates.index(today_ymd)
    return is_wipeout(n, neighbor_median(counts, idx), drop_frac)


def last_real_packed_xy(
    frames: Iterable[DayFrame],
    catalog: TimelineCatalog,
    *,
    on_or_before: date | None = None,
) -> dict[int, tuple[float, float]]:
    """Last non-synthetic frame coords, keyed by NORAD."""
    cap = date_to_ymd(on_or_before) if on_or_before is not None else None
    last = last_real_frame(frames, on_or_before=cap)
    if last is None:
        return {}
    out: dict[int, tuple[float, float]] = {}
    for slot, xu, yu in zip(last.slots, last.xs, last.ys):
        if slot < 0 or slot >= len(catalog.sats):
            continue
        out[catalog.sats[slot].id] = (unpack_u16(xu), unpack_u16(yu))
    return out
