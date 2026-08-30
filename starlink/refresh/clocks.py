"""Assign each sat a J2 pile clock: frozen tight pile, draft-lock, or daily clump."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import numpy as np

from refresh.j2 import T0, T0_ISO, j2_rates, lock_xy, noon_utc
from refresh.parse import Sat
from refresh.shells import INC_WINDOWS, tight_piles

# Pair a newly detected peak to a frozen pile if |Δkm| is within this
# and closer than any other unpaired pile (greedy). 2.5 km absorbs 1 km
# histogram jitter without merging the 460/463/465 operational shells.
PILE_MATCH_KM = 2.5


@dataclass
class PileRef:
    id: str
    inc: int
    km: int
    n: float
    i: float
    e: float
    first: str

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "inc": self.inc,
            "km": self.km,
            "n": self.n,
            "i": self.i,
            "e": self.e,
            "first": self.first,
        }

    @classmethod
    def from_json(cls, rec: dict) -> PileRef:
        return cls(
            id=str(rec["id"]),
            inc=int(rec["inc"]),
            km=int(rec["km"]),
            n=float(rec["n"]),
            i=float(rec["i"]),
            e=float(rec["e"]),
            first=str(rec.get("first", "")),
        )


@dataclass
class ShellRefs:
    t0: datetime = T0
    piles: list[PileRef] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"t0": T0_ISO, "piles": [p.to_json() for p in self.piles]}

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> ShellRefs:
        if not path.exists():
            return cls()
        rec = json.loads(path.read_text(encoding="utf-8"))
        piles = [PileRef.from_json(p) for p in rec.get("piles", [])]
        return cls(t0=T0, piles=piles)

    def piles_at(self, inc: int) -> list[PileRef]:
        return [p for p in self.piles if p.inc == inc]


@dataclass(frozen=True)
class Clock:
    n_shell: float
    i_ref: float
    e_ref: float
    pile_id: str | None
    kind: str  # pile | draft | clump | own


def inc_bucket(inclination: float) -> int | None:
    for bucket, (lo, hi) in INC_WINDOWS.items():
        if lo <= inclination <= hi:
            return bucket
    return None


def nearest_inc_bucket(inclination: float) -> int:
    hit = inc_bucket(inclination)
    if hit is not None:
        return hit
    return min(INC_WINDOWS, key=lambda b: abs(b - inclination))


def _median(vals: list[float]) -> float:
    return float(np.median(np.asarray(vals, dtype=float)))


def _freeze_new(inc: int, peak_km: int, members: list[Sat], day: str) -> PileRef:
    return PileRef(
        id=f"{inc}-{peak_km}",
        inc=inc,
        km=int(peak_km),
        n=_median([s.mean_motion for s in members]),
        i=_median([s.inclination for s in members]),
        e=_median([s.ecc for s in members]),
        first=day,
    )


def _match_piles(
    inc: int,
    detected: list[tuple],
    refs: ShellRefs,
    day: str,
) -> list[tuple]:
    """Return [(shell, members, pile_ref), ...] after freezing new piles.

    `detected` is the list from tight_piles: (Shell, members).
    """
    frozen = list(refs.piles_at(inc))
    pairs: list[tuple[int, int, float]] = []  # (det_i, fr_j, dist)
    for di, (sh, _members) in enumerate(detected):
        pk = sh.peak_km if sh.peak_km is not None else 0
        for fj, fr in enumerate(frozen):
            dist = abs(float(pk) - float(fr.km))
            if dist <= PILE_MATCH_KM:
                pairs.append((di, fj, dist))
    pairs.sort(key=lambda t: t[2])
    assigned: dict[int, PileRef] = {}
    used_fr: set[int] = set()
    for di, fj, _dist in pairs:
        if di in assigned or fj in used_fr:
            continue
        assigned[di] = frozen[fj]
        used_fr.add(fj)

    out: list[tuple] = []
    for di, (sh, members) in enumerate(detected):
        if di in assigned:
            out.append((sh, members, assigned[di]))
            continue
        pk = int(sh.peak_km or 0)
        pile = _freeze_new(inc, pk, members, day)
        # Keep pile ids unique if detect_peaks repeats a km.
        existing = {p.id for p in refs.piles}
        if pile.id in existing:
            pile = _freeze_new(inc, pk, members, day)
            suffix = 2
            while f"{inc}-{pk}-{suffix}" in existing:
                suffix += 1
            pile = PileRef(
                id=f"{inc}-{pk}-{suffix}",
                inc=inc,
                km=pk,
                n=pile.n,
                i=pile.i,
                e=pile.e,
                first=day,
            )
        refs.piles.append(pile)
        out.append((sh, members, pile))
    return out


def assign_clocks(
    sats: list[Sat],
    refs: ShellRefs,
    day: str,
) -> dict[int, Clock]:
    """Assign a clock to each sat. New tight piles are appended to refs."""
    by_inc: dict[int, list[Sat]] = {k: [] for k in INC_WINDOWS}
    other: list[Sat] = []
    for s in sats:
        b = inc_bucket(s.inclination)
        if b is None:
            other.append(s)
        else:
            by_inc[b].append(s)

    clocks: dict[int, Clock] = {}
    for inc, group in by_inc.items():
        if not group:
            continue
        detected = tight_piles(inc, group)
        matched = _match_piles(inc, detected, refs, day)
        largest: PileRef | None = None
        if matched:
            largest = max(matched, key=lambda t: len(t[1]))[2]
        med_n = _median([s.mean_motion for s in group])
        med_i = _median([s.inclination for s in group])
        med_e = _median([s.ecc for s in group])

        sat_pile: dict[int, PileRef] = {}
        for sh, members, pile in matched:
            for s in members:
                prev = sat_pile.get(s.norad_id)
                if prev is None:
                    sat_pile[s.norad_id] = pile
                    continue
                d_new = abs(s.altitude_km - float(sh.peak_km or pile.km))
                d_old = abs(s.altitude_km - float(prev.km))
                if d_new < d_old:
                    sat_pile[s.norad_id] = pile

        for s in group:
            pile = sat_pile.get(s.norad_id)
            if pile is not None:
                clocks[s.norad_id] = Clock(pile.n, pile.i, pile.e, pile.id, "pile")
            elif largest is not None:
                clocks[s.norad_id] = Clock(
                    largest.n, largest.i, largest.e, largest.id, "draft"
                )
            else:
                clocks[s.norad_id] = Clock(med_n, med_i, med_e, None, "clump")

    for s in other:
        clocks[s.norad_id] = Clock(s.mean_motion, s.inclination, s.ecc, None, "own")
    return clocks


def locked_xy(sat: Sat, clock: Clock, t: datetime, t0: datetime = T0) -> tuple[float, float]:
    omega_dot, argp_dot = j2_rates(clock.n_shell, clock.i_ref, clock.e_ref)
    return lock_xy(
        argp=sat.argp,
        mean_anomaly=sat.mean_anomaly,
        mean_motion=sat.mean_motion,
        raan=sat.raan,
        epoch=sat.epoch,
        t=t,
        n_shell=clock.n_shell,
        omega_dot_deg_s=argp_dot,
        Omega_dot_deg_s=omega_dot,
        t0=t0,
    )


def frame_noon(day: date | datetime | str) -> datetime:
    if isinstance(day, str):
        return noon_utc(date.fromisoformat(day[:10]))
    return noon_utc(day)
