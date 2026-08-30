"""Per-sat clock continuity offsets and light pile-only smoothing.

Changing n_shell after years wraps x/y by 360*Δn*days. On a clock change
(different pile_id or Δn), set offsets so plot x,y match yesterday. Keep
those offsets while the sat stays on that clock.

Persisted as timeline/lock_state.json (not secret):
  norad -> n, i, e, pile_id, ox, oy, x, y, kind
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from refresh.clocks import Clock, locked_xy
from refresh.parse import Sat

EMA_ALPHA = 0.4
N_EPS = 1e-6


def wrap360(deg: float) -> float:
    return float(deg) % 360.0


def shortest_delta(from_deg: float, to_deg: float) -> float:
    return ((to_deg - from_deg + 180.0) % 360.0) - 180.0


def circular_ema(prev: float, new: float, alpha: float = EMA_ALPHA) -> float:
    return wrap360(prev + alpha * shortest_delta(prev, new))


@dataclass
class SatLock:
    n: float
    i: float
    e: float
    pile_id: str | None
    ox: float
    oy: float
    x: float
    y: float
    kind: str

    def to_json(self) -> dict:
        return {
            "n": self.n,
            "i": self.i,
            "e": self.e,
            "pile_id": self.pile_id,
            "ox": self.ox,
            "oy": self.oy,
            "x": self.x,
            "y": self.y,
            "kind": self.kind,
        }

    @classmethod
    def from_json(cls, rec: dict) -> SatLock:
        pile = rec.get("pile_id")
        return cls(
            n=float(rec["n"]),
            i=float(rec["i"]),
            e=float(rec["e"]),
            pile_id=None if pile in (None, "") else str(pile),
            ox=float(rec.get("ox", 0.0)),
            oy=float(rec.get("oy", 0.0)),
            x=float(rec["x"]),
            y=float(rec["y"]),
            kind=str(rec.get("kind", "own")),
        )


@dataclass
class LockState:
    """norad -> last plot clock. Optional top-level day for same-day reuse."""

    day: str = ""
    sats: dict[int, SatLock] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "day": self.day,
            "sats": {str(nid): rec.to_json() for nid, rec in self.sats.items()},
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), separators=(",", ":")) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> LockState:
        if not path.exists():
            return cls()
        rec = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(rec, dict):
            return cls()
        if "sats" in rec:
            day = str(rec.get("day", ""))
            raw = rec.get("sats") or {}
        else:
            day = str(rec.get("day", ""))
            raw = {k: v for k, v in rec.items() if k != "day" and isinstance(v, dict)}
        sats: dict[int, SatLock] = {}
        for key, val in raw.items():
            try:
                sats[int(key)] = SatLock.from_json(val)
            except (KeyError, TypeError, ValueError):
                continue
        return cls(day=day, sats=sats)


def hold_own_clock(clock: Clock, prev: SatLock | None) -> Clock:
    """Keep the first own n/i/e until the sat joins a pile."""
    if clock.kind != "own" or prev is None or prev.kind != "own":
        return clock
    return Clock(prev.n, prev.i, prev.e, None, "own")


def clock_changed(prev: SatLock | None, clock: Clock) -> bool:
    if prev is None:
        return False
    if (prev.pile_id or "") != (clock.pile_id or ""):
        return True
    return abs(prev.n - clock.n_shell) > N_EPS


def apply_locks(
    sats: list[Sat],
    clocks: dict[int, Clock],
    t: datetime,
    state: LockState,
    day: str,
) -> dict[int, tuple[float, float]]:
    """Offsets + pile-only EMA. Mutates state. Same day returns stored x,y."""
    same_day = bool(state.day) and state.day == day
    out: dict[int, tuple[float, float]] = {}
    for s in sats:
        clock = clocks.get(s.norad_id)
        if clock is None:
            continue
        prev = state.sats.get(s.norad_id)
        if same_day and prev is not None:
            out[s.norad_id] = (prev.x, prev.y)
            continue
        clock = hold_own_clock(clock, prev)
        raw_x, raw_y = locked_xy(s, clock, t)
        changed = clock_changed(prev, clock)
        if prev is None:
            ox = oy = 0.0
            plot_x, plot_y = wrap360(raw_x), wrap360(raw_y)
        elif changed:
            ox = (prev.x - raw_x) % 360.0
            oy = (prev.y - raw_y) % 360.0
            plot_x = wrap360(raw_x + ox)
            plot_y = wrap360(raw_y + oy)
        else:
            ox, oy = prev.ox, prev.oy
            adj_x = wrap360(raw_x + ox)
            adj_y = wrap360(raw_y + oy)
            if clock.kind == "pile":
                plot_x = circular_ema(prev.x, adj_x, EMA_ALPHA)
                plot_y = circular_ema(prev.y, adj_y, EMA_ALPHA)
            else:
                plot_x, plot_y = adj_x, adj_y
        state.sats[s.norad_id] = SatLock(
            n=clock.n_shell,
            i=clock.i_ref,
            e=clock.e_ref,
            pile_id=clock.pile_id,
            ox=ox,
            oy=oy,
            x=plot_x,
            y=plot_y,
            kind=clock.kind,
        )
        out[s.norad_id] = (plot_x, plot_y)
    state.day = day
    return out
