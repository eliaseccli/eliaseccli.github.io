"""Dump all inclination shells to one JSON file for the interactive page."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from refresh.fetch import load_catalog
from refresh.orbit import position_at
from refresh.parse import parse_omm_records, parse_tle_file
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


def dump_sats(out_path: Path) -> dict:
    catalog = load_catalog()
    if catalog.kind == "json":
        sats = parse_omm_records(catalog.records or [])
    else:
        sats = parse_tle_file(catalog.path)
    if not sats:
        raise SystemExit("no satellites parsed")

    t = max(s.epoch for s in sats)
    shells_out: list[dict] = []
    sats_out: list[dict] = []
    extra_i = 0

    for inc in INC_ORDER:
        subset = filter_inclination(sats, inc)
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
                x, y = position_at(s, t)
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
                x, y = position_at(s, t)
                sats_out.append({
                    "name": s.name,
                    "id": s.norad_id,
                    "x": round(x, 4),
                    "y": round(y, 4),
                    "alt": round(s.altitude_km, 3),
                    "s": sid,
                })

    payload = {
        "epoch": t.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Celestrak GP JSON" if catalog.kind == "json" else "TLE fallback",
        "n": len(sats_out),
        "catalog": len(sats),
        "shells": shells_out,
        "sats": sats_out,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return payload
