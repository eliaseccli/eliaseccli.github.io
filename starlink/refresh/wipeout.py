"""20%+ catalog wipeouts: drop as real dumps, interpolate, then 10-day smooth.

A day is a wipeout when its sat count (set bits in that day's catalog bitmask)
is ≥20% below the median of a 7-day centered window of *neighboring* days.
The window does not wrap, and the day itself is not in the baseline (no
circular self-hit). Detection uses real-dump counts only.

Wipeout days are not real catalogs: they do not advance `end`, do not run
shell-clock matching, and do not add NORAD IDs. Play still gets a frame:
slots that exist on both bounding real days are shortest-arc lerped (x and y
are 360°). One-sided sats are omitted (packed bins have no alpha). Do not
invent slots. A 1-day membership dropout (sat on both neighbors, missing
today, day not a wipeout) is held by shortest-arc lerp.

After hole-fill, Play positions are a triangular shortest-arc mean over
calendar days [d-9 .. d+9] (weights 10-|k|, the 10-day box mean applied
twice). Gaps and missing slots just drop out of the window. The newest days
use a one-sided window and are re-smoothed from raw_tail.bin as later days
arrive. Clocks stay on real unsmoothed dumps.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from statistics import median
from typing import Iterable

import numpy as np

from refresh.binary import DayFrame, MonthBin, read_month, write_month, ymd_int
from refresh.catalog import TimelineCatalog, write_manifest
from refresh.j2 import pack_u16, unpack_u16
from refresh.lock import shortest_delta, wrap360

FLAG_SYNTHETIC = 0x01
WINDOW_HALF = 3  # 7-day centered window: 3 neighbors each side + self
DROP_FRAC = 0.20
# Play smooth: triangular weights 10-|k| over calendar days d-9 .. d+9.
SMOOTH_HALF = 9
# Raw (pre-smooth) frames kept so the newest SMOOTH_HALF days can be redone.
RAW_TAIL_DAYS = 2 * SMOOTH_HALF + 3  # +2 slack for a missed run
RAW_TAIL_NAME = "raw_tail.bin"


def is_synthetic(flags: int) -> bool:
    return bool(flags & FLAG_SYNTHETIC)


def ymd_to_date(ymd: int) -> date:
    return date(ymd // 10000, (ymd // 100) % 100, ymd % 100)


def date_to_ymd(d: date) -> int:
    return ymd_int(d.year, d.month, d.day)


def ymd_to_iso(ymd: int) -> str:
    return ymd_to_date(ymd).isoformat()


def neighbor_median(
    counts: list[int | None],
    index: int,
    half: int = WINDOW_HALF,
) -> float | None:
    """Median of a centered window excluding self. No circular wrap.

    None entries (synthetic / missing real counts) are skipped so the
    baseline is neighboring *real* dumps only.
    """
    n = len(counts)
    if n < 2 or index < 0 or index >= n:
        return None
    lo = max(0, index - half)
    hi = min(n, index + half + 1)
    neigh = [counts[j] for j in range(lo, hi) if j != index and counts[j] is not None]
    if not neigh:
        return None
    return float(median(neigh))


def is_wipeout(n: int, baseline: float | None, drop_frac: float = DROP_FRAC) -> bool:
    """True when n is ≥ drop_frac below the neighbor median."""
    if baseline is None or baseline <= 0:
        return False
    return n <= (1.0 - drop_frac) * baseline


def wipeout_mask(
    counts: list[int | None],
    *,
    drop_frac: float = DROP_FRAC,
    half: int = WINDOW_HALF,
) -> list[bool]:
    """None (no real count) is treated as already a hole."""
    out: list[bool] = []
    for i, n in enumerate(counts):
        if n is None:
            out.append(True)
            continue
        out.append(is_wipeout(n, neighbor_median(counts, i, half=half), drop_frac))
    return out


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


def circular_mean(angles: list[float]) -> float:
    """Shortest-arc mean on a 360° wrap. Empty → 0."""
    if not angles:
        return 0.0
    ref = angles[0]
    return wrap360(ref + sum(shortest_delta(ref, a) for a in angles) / len(angles))


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


def _pos_map(frame: DayFrame) -> dict[int, tuple[int, int]]:
    return {s: (x, y) for s, x, y in zip(frame.slots, frame.xs, frame.ys)}


def hold_one_day_dropouts(frames: list[DayFrame]) -> list[DayFrame]:
    """Keep a sat that exists on both neighbors but is missing today.

    Only for non-wipeout days. Position is a shortest-arc lerp of the two
    neighbors (t=0.5). Does not invent slots that are absent on either side.
    """
    if len(frames) < 3:
        return frames
    out: list[DayFrame] = []
    for i, frame in enumerate(frames):
        if is_synthetic(frame.flags) or i == 0 or i + 1 >= len(frames):
            out.append(frame)
            continue
        prev, nxt = frames[i - 1], frames[i + 1]
        have = set(frame.slots)
        missing = sorted((set(prev.slots) & set(nxt.slots)) - have)
        if not missing:
            out.append(frame)
            continue
        pos_p, pos_n = _pos_map(prev), _pos_map(nxt)
        slots = list(frame.slots)
        xs = list(frame.xs)
        ys = list(frame.ys)
        for slot in missing:
            xb, yb = pos_p[slot]
            xa, ya = pos_n[slot]
            slots.append(slot)
            xs.append(pack_u16(lerp_angle(unpack_u16(xb), unpack_u16(xa), 0.5)))
            ys.append(pack_u16(lerp_angle(unpack_u16(yb), unpack_u16(ya), 0.5)))
        order = sorted(range(len(slots)), key=lambda k: slots[k])
        out.append(
            DayFrame(
                date=frame.date,
                flags=frame.flags,
                slots=[slots[k] for k in order],
                xs=[xs[k] for k in order],
                ys=[ys[k] for k in order],
            )
        )
    return out


def _dense(frame: DayFrame, width: int) -> tuple["np.ndarray", "np.ndarray"]:
    """Slot-indexed float x/y (degrees), NaN where the slot is absent."""
    x = np.full(width, np.nan)
    y = np.full(width, np.nan)
    if frame.slots:
        idx = np.asarray(frame.slots, dtype=np.int64)
        x[idx] = np.asarray(frame.xs, dtype=np.float64) * (360.0 / 65536.0)
        y[idx] = np.asarray(frame.ys, dtype=np.float64) * (360.0 / 65536.0)
    return x, y


def smooth_nday(
    frames: list[DayFrame],
    *,
    only_from: int | None = None,
) -> list[DayFrame]:
    """Triangular shortest-arc mean over calendar days [d-9 .. d+9].

    Weight of a neighbor k days away is 10-|k| (= the 10-day box mean applied
    twice). Window is by calendar date, so a missing day just drops out; a
    slot missing on some days is averaged over the days it has. At the newest
    end the window is one-sided (trailing) and is recomputed as later days
    arrive. Only slots present on day d are written (no new slots).
    Frames dated before `only_from` (YYYYMMDD) are returned unchanged.
    """
    if not frames:
        return frames
    width = max((max(f.slots, default=-1) + 1) for f in frames)
    if width <= 0:
        return frames
    ords = [ymd_to_date(f.date).toordinal() for f in frames]
    cache: dict[int, tuple] = {}

    def dense(j: int):
        got = cache.get(j)
        if got is None:
            got = _dense(frames[j], width)
            cache[j] = got
        return got

    out: list[DayFrame] = []
    lo = 0
    for i, cur in enumerate(frames):
        if (only_from is not None and cur.date < only_from) or not cur.slots:
            out.append(cur)
            continue
        while ords[lo] < ords[i] - SMOOTH_HALF:
            cache.pop(lo, None)
            lo += 1
        hi = i
        while hi + 1 < len(frames) and ords[hi + 1] <= ords[i] + SMOOTH_HALF:
            hi += 1
        cx, cy = dense(i)
        idx = np.asarray(cur.slots, dtype=np.int64)
        c_x, c_y = cx[idx], cy[idx]
        sx = np.zeros(len(idx))
        sy = np.zeros(len(idx))
        sw = np.zeros(len(idx))
        for j in range(lo, hi + 1):
            w = SMOOTH_HALF + 1 - abs(ords[j] - ords[i])
            nx, ny = dense(j)
            vx, vy = nx[idx], ny[idx]
            ok = ~np.isnan(vx)
            dx = (vx - c_x + 180.0) % 360.0 - 180.0
            dy = (vy - c_y + 180.0) % 360.0 - 180.0
            sx += np.where(ok, w * dx, 0.0)
            sy += np.where(ok, w * dy, 0.0)
            sw += np.where(ok, w, 0)
        mx = (c_x + sx / sw) % 360.0
        my = (c_y + sy / sw) % 360.0
        xs = [pack_u16(float(v)) for v in mx]
        ys = [pack_u16(float(v)) for v in my]
        out.append(DayFrame(date=cur.date, flags=cur.flags, slots=list(cur.slots), xs=xs, ys=ys))
    return out


def raw_tail_path(v1_dir: Path) -> Path:
    # Lives in v1/ so the daily workflow's `git add .../v1/*.bin` keeps it.
    # load_months skips it (stem is not YYYY-MM); the page never fetches it.
    return Path(v1_dir) / RAW_TAIL_NAME


def read_raw_tail(v1_dir: Path) -> dict[int, DayFrame]:
    path = raw_tail_path(v1_dir)
    if not path.exists():
        return {}
    try:
        return {f.date: f for f in read_month(path).days}
    except ValueError:
        return {}


def write_raw_tail(v1_dir: Path, raw: Iterable[DayFrame]) -> None:
    """Keep the newest RAW_TAIL_DAYS real raw frames (pre-smooth) for re-smoothing."""
    days = sorted((f for f in raw if not is_synthetic(f.flags)), key=lambda f: f.date)
    if not days:
        return
    cut = ymd_to_date(days[-1].date).toordinal() - (RAW_TAIL_DAYS - 1)
    days = [f for f in days if ymd_to_date(f.date).toordinal() >= cut]
    d0 = ymd_to_date(days[0].date)
    width = max((max(f.slots, default=-1) + 1) for f in days)
    write_month(
        raw_tail_path(v1_dir),
        MonthBin(year=d0.year, month=d0.month, catalog_len=width, first_date=days[0].date, days=days),
    )


def upsert_raw_tail(v1_dir: Path, frame: DayFrame) -> None:
    raw = read_raw_tail(v1_dir)
    raw[frame.date] = frame
    write_raw_tail(v1_dir, raw.values())


def load_months(v1_dir: Path) -> dict[str, MonthBin]:
    months: dict[str, MonthBin] = {}
    if not v1_dir.exists():
        return months
    for path in sorted(v1_dir.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].bin")):
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
    smooth: str = "tail",
    resmooth_from: date | None = None,
) -> dict:
    """Fill holes, hold 1-day dropouts, then triangular 19-day smooth.

    smooth="all": the bins hold raw frames (pack_timeline). Every hole is
    re-filled and every day smoothed.

    smooth="tail" (daily append, fill-holes): bins before the active range
    are final and are not touched. Active range = `resmooth_from` or the
    newest day minus SMOOTH_HALF. Raw frames come from raw_tail.bin when
    present, else from the bins (then they must still be raw). In the
    active range, wipeouts, FLAG_SYNTHETIC days, `extra_holes`, and missing
    calendar days become interpolated (or held) synthetic frames; then days
    in the range are re-smoothed with the context of up to SMOOTH_HALF older
    days. raw_tail.bin is rewritten with the newest real raw frames.
    """
    v1_dir = Path(v1_dir)
    months = load_months(v1_dir)
    ordered = flatten_frames(months)
    extra = {date_to_ymd(d) for d in (extra_holes or [])}
    if not ordered and not extra:
        return {"synthetic": [], "last_real": None, "days": 0, "bytes": 0, "months": [], "rewritten": []}

    raw_tail = read_raw_tail(v1_dir) if smooth == "tail" else {}
    src = {f.date: raw_tail.get(f.date, f) for f in ordered}
    for ymd, f in raw_tail.items():
        src.setdefault(ymd, f)
    all_dates = sorted(set(src) | extra)
    newest = ymd_to_date(all_dates[-1])
    if smooth == "all":
        active_from = all_dates[0]
    else:
        start = resmooth_from or (newest - timedelta(days=SMOOTH_HALF))
        active_from = date_to_ymd(start)
        # Missing calendar days in the active range become synthetic fills.
        first_real = min(src) if src else active_from
        d = max(ymd_to_date(active_from), ymd_to_date(first_real))
        while d <= newest:
            if date_to_ymd(d) not in src:
                extra.add(date_to_ymd(d))
            d += timedelta(days=1)
        all_dates = sorted(set(src) | extra)
    ctx_from = date_to_ymd(ymd_to_date(active_from) - timedelta(days=SMOOTH_HALF))

    series_in = [src[y] for y in sorted(src)]
    counts: list[int | None] = [None if is_synthetic(f.flags) else len(f.slots) for f in series_in]
    mask = wipeout_mask(counts)
    holes: set[int] = set(extra)
    for frame, wo in zip(series_in, mask):
        if frame.date >= active_from and (wo or is_synthetic(frame.flags)):
            holes.add(frame.date)
    reals = [f for f in series_in if f.date not in holes and not is_synthetic(f.flags)]

    work_dates = [y for y in all_dates if y >= ctx_from]
    work: list[DayFrame] = []
    for ymd in work_dates:
        if ymd not in holes:
            work.append(src[ymd])
            continue
        before = next((f for f in reversed(reals) if f.date < ymd), None)
        after = next((f for f in reals if f.date > ymd), None)
        if before is not None and after is not None:
            work.append(interpolate_frame(before, after, ymd))
        elif before is not None:
            work.append(hold_frame(before, ymd))
        else:
            work.append(empty_synthetic(ymd))

    held = hold_one_day_dropouts(work)
    smoothed = smooth_nday(held, only_from=active_from)
    filled = {f.date: f for f in ordered}
    for f in smoothed:
        if f.date >= active_from:
            filled[f.date] = f
    keep = dict(raw_tail)
    keep.update({f.date: f for f in work if f.date not in holes})
    write_raw_tail(v1_dir, keep.values())

    rewritten: list[str] = []
    by_ym: dict[str, list[DayFrame]] = {}
    for ymd, frame in filled.items():
        d = ymd_to_date(ymd)
        by_ym.setdefault(f"{d.year:04d}-{d.month:02d}", []).append(frame)
    for ym, days in by_ym.items():
        days.sort(key=lambda f: f.date)
        old = months.get(ym)
        catalog_len = old.catalog_len if old is not None else 0
        catalog_len = max(catalog_len, max((max(f.slots, default=-1) + 1) for f in days))
        if old is not None and old.days == days and old.catalog_len == catalog_len:
            continue
        y, m = int(ym[:4]), int(ym[5:7])
        month = MonthBin(year=y, month=m, catalog_len=catalog_len, first_date=days[0].date, days=days)
        write_month(v1_dir / f"{ym}.bin", month)
        months[ym] = month
        rewritten.append(ym)

    last = last_real_frame(filled.values())
    synthetic = [ymd_to_iso(y) for y in sorted(filled) if is_synthetic(filled[y].flags)]
    bytes_total = sum(p.stat().st_size for p in v1_dir.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].bin")) if v1_dir.exists() else 0
    return {
        "synthetic": synthetic,
        "last_real": ymd_to_iso(last.date) if last is not None else None,
        "days": sum(len(m.days) for m in months.values()),
        "bytes": bytes_total,
        "months": sorted(months),
        "rewritten": rewritten,
    }


def apply_hole_fill(
    timeline_dir: Path,
    *,
    extra_holes: Iterable[date] | None = None,
    smooth: str = "tail",
    resmooth_from: date | None = None,
) -> dict:
    """Fill v1/ holes and point catalog/manifest `end` at the last real dump."""
    timeline_dir = Path(timeline_dir)
    v1 = timeline_dir / "v1"
    info = fill_v1_holes(v1, extra_holes=extra_holes, smooth=smooth, resmooth_from=resmooth_from)
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
    """True when today's sat count trips the 20% neighbor-median rule."""
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
