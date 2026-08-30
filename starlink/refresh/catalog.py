"""Append-only timeline catalog.json (never reorder existing NORAD slots)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from refresh.clocks import nearest_inc_bucket
from refresh.parse import Sat

CATALOG_V = 1
PLAYBACK_FPS = 15
START_ISO = "2019-05-24"


@dataclass
class CatalogSat:
    id: int
    name: str
    inc: int


@dataclass
class TimelineCatalog:
    v: int = CATALOG_V
    start: str = START_ISO
    end: str = START_ISO
    fps: int = PLAYBACK_FPS
    sats: list[CatalogSat] = field(default_factory=list)
    _index: dict[int, int] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self._index = {s.id: i for i, s in enumerate(self.sats)}

    def slot_of(self, norad_id: int) -> int | None:
        return self._index.get(norad_id)

    def append_sat(self, sat: Sat) -> int:
        existing = self._index.get(sat.norad_id)
        if existing is not None:
            return existing
        rec = CatalogSat(
            id=sat.norad_id,
            name=sat.name,
            inc=nearest_inc_bucket(sat.inclination),
        )
        self._index[sat.norad_id] = len(self.sats)
        self.sats.append(rec)
        return len(self.sats) - 1

    def to_json(self) -> dict:
        return {
            "v": self.v,
            "start": self.start,
            "end": self.end,
            "fps": self.fps,
            "sats": [{"id": s.id, "name": s.name, "inc": s.inc} for s in self.sats],
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), separators=(",", ":")), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> TimelineCatalog:
        rec = json.loads(path.read_text(encoding="utf-8"))
        sats = [
            CatalogSat(id=int(s["id"]), name=str(s["name"]), inc=int(s["inc"]))
            for s in rec.get("sats", [])
        ]
        return cls(
            v=int(rec.get("v", CATALOG_V)),
            start=str(rec.get("start", START_ISO)),
            end=str(rec.get("end", START_ISO)),
            fps=int(rec.get("fps", PLAYBACK_FPS)),
            sats=sats,
        )


def write_manifest(
    path: Path,
    *,
    start: str,
    end: str,
    months: list[str],
    catalog: int,
    days: int,
    bytes_total: int,
) -> None:
    payload = {
        "start": start,
        "end": end,
        "months": months,
        "catalog": catalog,
        "days": days,
        "bytes": bytes_total,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
