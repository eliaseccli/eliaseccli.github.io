"""Dump all inclination shells to one JSON file for the interactive page."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from refresh.clocks import ShellRefs, assign_clocks
from refresh.fetch import GP_CACHE, load_catalog
from refresh.lock import LockState, apply_locks
from refresh.parse import Sat, parse_omm_records, parse_tle_file
from refresh.shells import filter_inclination, in_shell, listed_shells

# Stable colors per (inc, peak). New auto-detected shells cycle the extras.
COLORS = {
    (43, 356): "#34d399",
    (43, 483): "#059669",
    (53, 360): "#60a5fa",
    (53, 460): "#fb923c",
    (53, 463): "#f97316",
    (53, 465): "#facc15",
    (53, 471): "#f43f5e",
    (53, 540): "#c084fc",
    (70, 350): "#22d3ee",
    (70, 572): "#0891b2",
    (97, 344): "#c4b5fd",
    (97, 465): "#8b5cf6",
    (97, 549): "#6366f1",
}
EXTRA = ["#94a3b8", "#e879f9", "#2dd4bf", "#f472b6", "#a3e635"]
RAISING_COLOR = "#64748b"
INC_ORDER = (43, 53, 70, 97)
INC_LABEL = {43: "43°", 53: "53°", 70: "70°", 97: "97.6°"}
DEFAULT_TIMELINE = Path("starlink/timeline")


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


def _load_sats(sats: list[Sat] | None) -> tuple[list[Sat], str]:
    if sats is not None:
        return sats, "injected"
    if GP_CACHE.exists():
        rec = json.loads(GP_CACHE.read_text(encoding="utf-8"))
        if isinstance(rec, list):
            return parse_omm_records(rec), "Celestrak GP JSON"
    catalog = load_catalog()
    if catalog.kind == "json":
        parsed = parse_omm_records(catalog.records or [])
        source = "Celestrak GP JSON"
    else:
        parsed = parse_tle_file(catalog.path)
        source = "TLE fallback"
    return parsed, source


def dump_sats(
    out_path: Path,
    *,
    timeline_dir: Path | None = None,
    frame_date: date | None = None,
    sats: list[Sat] | None = None,
) -> dict:
    parsed, source = _load_sats(sats)
    if not parsed:
        raise SystemExit("no satellites parsed")

    day = frame_date or _utc_today()
    t = datetime(day.year, day.month, day.day, 12, 0, 0)
    td = Path(timeline_dir) if timeline_dir is not None else DEFAULT_TIMELINE
    refs = ShellRefs.load(td / "shell_refs.json")
    lock_state = LockState.load(td / "lock_state.json")
    clocks = assign_clocks(parsed, refs, day.isoformat())
    xy = apply_locks(parsed, clocks, t, lock_state, day.isoformat())

    shells_out: list[dict] = []
    sats_out: list[dict] = []
    extra_i = 0

    for inc in INC_ORDER:
        subset = filter_inclination(parsed, inc)
        if not subset:
            continue
        assigned: set[int] = set()
        for sh in listed_shells(inc, subset):
            if sh.peak_km is None:
                continue
            members = [s for s in subset if in_shell(s, sh)]
            if not members:
                continue
            sid = f"{inc}-{sh.peak_km}"
            color = COLORS.get((inc, sh.peak_km))
            if color is None:
                color = EXTRA[extra_i % len(EXTRA)]
                extra_i += 1
            shells_out.append({
                "id": sid,
                "inc": inc,
                "km": sh.peak_km,
                "label": f"{INC_LABEL[inc]} · {sh.peak_km} km",
                "n": len(members),
                "color": color,
                "listed": True,
            })
            for s in members:
                assigned.add(s.norad_id)
                x, y = xy.get(s.norad_id, (0.0, 0.0))
                sats_out.append({
                    "name": s.name,
                    "id": s.norad_id,
                    "x": round(x, 4),
                    "y": round(y, 4),
                    "alt": round(s.altitude_km, 3),
                    "s": sid,
                })
        leftover = [s for s in subset if s.norad_id not in assigned]
        if leftover:
            sid = f"{inc}-raising"
            shells_out.append({
                "id": sid,
                "inc": inc,
                "km": None,
                "label": f"{INC_LABEL[inc]} · raising",
                "n": len(leftover),
                "color": RAISING_COLOR,
                "listed": False,
            })
            for s in leftover:
                x, y = xy.get(s.norad_id, (0.0, 0.0))
                sats_out.append({
                    "name": s.name,
                    "id": s.norad_id,
                    "x": round(x, 4),
                    "y": round(y, 4),
                    "alt": round(s.altitude_km, 3),
                    "s": sid,
                })

    catalog_epoch = max(s.epoch for s in parsed)
    payload = {
        "epoch": catalog_epoch.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "n": len(sats_out),
        "catalog": len(parsed),
        "shells": shells_out,
        "sats": sats_out,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return payload
