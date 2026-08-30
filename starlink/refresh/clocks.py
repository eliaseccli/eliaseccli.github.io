"""Assign each sat a J2 pile clock: frozen tight pile, closest-n draft, clump, or own."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import numpy as np

from refresh.j2 import T0, T0_ISO, j2_rates, lock_xy, noon_utc
from refresh.parse import Sat
from refresh.shells import INC_WINDOWS, Shell, is_tight, tight_piles

# Match a detected tight pile to a frozen pile only when inclination
# agrees and |Δn| is within this. 0.005 rev/day is ~1.5 km: enough for
# 1 km histogram jitter, not enough to merge 460/463/465 (Δn ≈ 0.012).
PILE_MATCH_N = 0.005
# Tight days at the same first-day n before (n, i, e) freeze.
STABLE_DAYS = 5
# Keep an unseen pending while (today - last) is within this many days.
PENDING_MISS_DAYS = 2
# detect_peaks min_count stays 25 for km checkboxes. CLOCKS only: a tight
# clump this large may pending-freeze as its own pile (histogram peak or
# whole-inclination fallback when no peak exists).
CLOCK_MIN_COUNT = 50


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
class PendingPile:
    """Unfrozen tight-pile streak. Persisted so a daily Action can finish a freeze."""

    inc: int
    km: int
    n: float
    i: float
    e: float
    streak: int
    last: str

    def to_json(self) -> dict:
        return {
            "inc": self.inc,
            "km": self.km,
            "n": self.n,
            "i": self.i,
            "e": self.e,
            "streak": self.streak,
            "last": self.last,
        }

    @classmethod
    def from_json(cls, rec: dict) -> PendingPile:
        return cls(
            inc=int(rec["inc"]),
            km=int(rec["km"]),
            n=float(rec["n"]),
            i=float(rec["i"]),
            e=float(rec["e"]),
            streak=int(rec["streak"]),
            last=str(rec["last"]),
        )


@dataclass
class ShellRefs:
    t0: datetime = T0
    piles: list[PileRef] = field(default_factory=list)
    pending: list[PendingPile] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "t0": T0_ISO,
            "piles": [p.to_json() for p in self.piles],
            "pending": [p.to_json() for p in self.pending],
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json(), indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> ShellRefs:
        if not path.exists():
            return cls()
        rec = json.loads(path.read_text(encoding="utf-8"))
        piles = [PileRef.from_json(p) for p in rec.get("piles", [])]
        pending = [PendingPile.from_json(p) for p in rec.get("pending", [])]
        return cls(t0=T0, piles=piles, pending=pending)

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


def _day(day: str) -> date:
    return date.fromisoformat(day[:10])


def _day_s(day: str) -> str:
    return day[:10]


def _greedy_pairs(pairs: list[tuple[int, int, float]]) -> dict[int, int]:
    """Greedy closest assignment: pairs are (left_i, right_j, dist)."""
    assigned: dict[int, int] = {}
    used: set[int] = set()
    for li, rj, _dist in sorted(pairs, key=lambda t: t[2]):
        if li in assigned or rj in used:
            continue
        assigned[li] = rj
        used.add(rj)
    return assigned


def _peak_stats(sh, members: list[Sat]) -> tuple[int, float, float, float]:
    km = int(sh.peak_km or 0)
    return (
        km,
        _median([s.mean_motion for s in members]),
        _median([s.inclination for s in members]),
        _median([s.ecc for s in members]),
    )


def _unique_pile_id(refs: ShellRefs, inc: int, km: int) -> str:
    existing = {p.id for p in refs.piles}
    base = f"{inc}-{km}"
    if base not in existing:
        return base
    suffix = 2
    while f"{inc}-{km}-{suffix}" in existing:
        suffix += 1
    return f"{inc}-{km}-{suffix}"


def _freeze_new(inc: int, km: int, n: float, i: float, e: float, day: str, refs: ShellRefs) -> PileRef:
    return PileRef(
        id=_unique_pile_id(refs, inc, km),
        inc=inc,
        km=int(km),
        n=n,
        i=i,
        e=e,
        first=_day_s(day),
    )


def _match_piles(
    inc: int,
    detected: list[tuple],
    refs: ShellRefs,
    day: str,
) -> list[tuple]:
    """Return [(shell, members, pile_ref), ...] for *frozen* piles only.

    A newly detected tight pile is stored as pending until STABLE_DAYS
    sightings at the same inc with |n_today - n0|<=PILE_MATCH_N. n0 is the
    first-day mean motion and is never updated (a slow climb cannot chase
    n into a freeze). Peak-km is a label: km/i/e refresh on each sighting
    for the freeze-day name. Misses of PENDING_MISS_DAYS are kept.
    Frozen (n, i, e) never update after freeze.
    """
    stats = [_peak_stats(sh, members) for sh, members in detected]
    frozen = list(refs.piles_at(inc))
    frozen_pairs: list[tuple[int, int, float]] = []
    for di, (_km, n, _i, _e) in enumerate(stats):
        for fj, fr in enumerate(frozen):
            dist = abs(n - fr.n)
            if dist <= PILE_MATCH_N:
                frozen_pairs.append((di, fj, dist))
    det_to_frozen = _greedy_pairs(frozen_pairs)
    matched: dict[int, PileRef] = {di: frozen[fj] for di, fj in det_to_frozen.items()}

    unmatched = [di for di in range(len(detected)) if di not in matched]
    pend_here = [(pi, p) for pi, p in enumerate(refs.pending) if p.inc == inc]
    pend_pairs: list[tuple[int, int, float]] = []
    for di in unmatched:
        _km, n, _i, _e = stats[di]
        for local_j, (_pi, prev) in enumerate(pend_here):
            if abs(n - prev.n) <= PILE_MATCH_N:
                pend_pairs.append((di, local_j, abs(n - prev.n)))
    det_to_pend = _greedy_pairs(pend_pairs)

    today = _day(day)
    used_local: set[int] = set()
    kept: list[PendingPile] = []
    for di in unmatched:
        km, n, i, e = stats[di]
        if di in det_to_pend:
            local_j = det_to_pend[di]
            used_local.add(local_j)
            prev = pend_here[local_j][1]
            gap = (today - _day(prev.last)).days
            if gap == 0:
                streak = prev.streak
                n0 = prev.n
                last = prev.last
            elif gap <= PENDING_MISS_DAYS:
                streak = prev.streak + 1
                n0 = prev.n
                last = _day_s(day)
            else:
                streak = 1
                n0 = n
                last = _day_s(day)
            if streak >= STABLE_DAYS:
                pile = _freeze_new(inc, km, n0, i, e, day, refs)
                refs.piles.append(pile)
                matched[di] = pile
            else:
                kept.append(
                    PendingPile(
                        inc=inc,
                        km=km,
                        n=n0,
                        i=i,
                        e=e,
                        streak=streak,
                        last=last,
                    )
                )
        else:
            kept.append(
                PendingPile(
                    inc=inc,
                    km=km,
                    n=n,
                    i=i,
                    e=e,
                    streak=1,
                    last=_day_s(day),
                )
            )

    for local_j, (_pi, prev) in enumerate(pend_here):
        if local_j in used_local:
            continue
        if (today - _day(prev.last)).days <= PENDING_MISS_DAYS:
            kept.append(prev)

    refs.pending = [p for p in refs.pending if p.inc != inc] + kept

    out: list[tuple] = []
    for di, (sh, members) in enumerate(detected):
        if di in matched:
            out.append((sh, members, matched[di]))
    return out


def _clock_detected(inc: int, group: list[Sat]) -> list[tuple[Shell, list[Sat]]]:
    """Tight piles for clock freeze. listed_shells / detect_peaks stay at 25.

    Only a tight clump of at least CLOCK_MIN_COUNT sats may pending-freeze.
    Histogram peaks below that floor are dropped (they do not merge via the
    whole-inclination fallback). When the histogram finds nothing, a tight
    inclination group of that size is one candidate at median km.
    """
    raw = tight_piles(inc, group)
    if raw:
        return [(sh, members) for sh, members in raw if len(members) >= CLOCK_MIN_COUNT]
    if len(group) < CLOCK_MIN_COUNT:
        return []
    alts = [s.altitude_km for s in group]
    if not is_tight(alts):
        return []
    km = int(round(_median(alts)))
    lo = float(min(alts))
    hi = float(max(alts)) + 1e-6
    return [(Shell(km, lo, hi), list(group))]


def _closest_pile(sat: Sat, frozen: list[PileRef]) -> PileRef | None:
    """Closest pile by |Δn|. No match-radius check."""
    if not frozen:
        return None
    return min(frozen, key=lambda p: abs(sat.mean_motion - p.n))


def _clump_clock(unmatched: list[Sat]) -> Clock:
    """One shared clock: daily median n/i/e of unmatched sats at this inclination."""
    return Clock(
        _median([s.mean_motion for s in unmatched]),
        _median([s.inclination for s in unmatched]),
        _median([s.ecc for s in unmatched]),
        None,
        "clump",
    )


def assign_clocks(
    sats: list[Sat],
    refs: ShellRefs,
    day: str,
) -> dict[int, Clock]:
    """Assign a clock to each sat. Stable tight piles freeze into refs.

    A frozen pile is an active shell today only if it has at least
    CLOCK_MIN_COUNT members in today's sat_pile. Those members use the
    pile's frozen n/i/e (kind=pile). Members of a sub-50 pile are leftovers,
    same as unmatched. If at least one active 50+ shell exists at that
    inclination, each leftover drafts to the closest active shell by n
    (any Δn, kind=draft). If there is no 50+ shell yet, leftovers share
    one kind=clump clock (daily median n, i, e). Odd-inclination loners
    stay kind=own. Pending streaks persist on refs for the daily Action.
    """
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
        detected = _clock_detected(inc, group)
        matched = _match_piles(inc, detected, refs, day)
        frozen_here = refs.piles_at(inc)

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

        pile_count: dict[str, int] = {}
        for pile in sat_pile.values():
            pile_count[pile.id] = pile_count.get(pile.id, 0) + 1
        active = [p for p in frozen_here if pile_count.get(p.id, 0) >= CLOCK_MIN_COUNT]
        active_ids = {p.id for p in active}

        leftovers: list[Sat] = []
        for s in group:
            pile = sat_pile.get(s.norad_id)
            if pile is not None and pile.id in active_ids:
                clocks[s.norad_id] = Clock(pile.n, pile.i, pile.e, pile.id, "pile")
            else:
                leftovers.append(s)
        if leftovers:
            if active:
                for s in leftovers:
                    closest = _closest_pile(s, active)
                    if closest is None:
                        continue
                    clocks[s.norad_id] = Clock(
                        closest.n, closest.i, closest.e, closest.id, "draft"
                    )
            else:
                clump = _clump_clock(leftovers)
                for s in leftovers:
                    clocks[s.norad_id] = clump

    today = _day(day)
    refs.pending = [
        p for p in refs.pending if (today - _day(p.last)).days <= PENDING_MISS_DAYS
    ]

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
