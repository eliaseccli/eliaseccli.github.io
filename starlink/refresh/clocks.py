"""Assign each sat a J2 pile clock: tight pile, closest-n draft, clump, or own.

x = u − (n_shell + ω̇)·(t − t0)  (mod 360). Changing n_shell by Δn without a
phase wraps x by −Δn·360·(t − t0) days. Every clock therefore carries (x0, y0)
and, whenever its (n, i, e) changes, those offsets absorb the wrap so the
majority of that shell stays put. Matched piles refine n/i/e to today's median
(same phase rule) so a slow drift cannot birth a sibling pile just outside
N_MATCH. Pending n0 is still not chased: a climb cannot freeze.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import numpy as np

from refresh.j2 import T0, T0_ISO, j2_rates, lock_xy, noon_utc
from refresh.orbit import deg_per_sec
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
    x0: float = 0.0
    y0: float = 0.0

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "inc": self.inc,
            "km": self.km,
            "n": self.n,
            "i": self.i,
            "e": self.e,
            "first": self.first,
            "x0": self.x0,
            "y0": self.y0,
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
            x0=float(rec.get("x0", 0.0)),
            y0=float(rec.get("y0", 0.0)),
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
class ClumpRef:
    """Persisted unmatched-clump clock so a daily n change can keep phase."""

    inc: int
    n: float
    i: float
    e: float
    x0: float = 0.0
    y0: float = 0.0

    def to_json(self) -> dict:
        return {
            "inc": self.inc,
            "n": self.n,
            "i": self.i,
            "e": self.e,
            "x0": self.x0,
            "y0": self.y0,
        }

    @classmethod
    def from_json(cls, rec: dict) -> ClumpRef:
        return cls(
            inc=int(rec["inc"]),
            n=float(rec["n"]),
            i=float(rec["i"]),
            e=float(rec["e"]),
            x0=float(rec.get("x0", 0.0)),
            y0=float(rec.get("y0", 0.0)),
        )


@dataclass
class ShellRefs:
    t0: datetime = T0
    piles: list[PileRef] = field(default_factory=list)
    pending: list[PendingPile] = field(default_factory=list)
    clumps: list[ClumpRef] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "t0": T0_ISO,
            "piles": [p.to_json() for p in self.piles],
            "pending": [p.to_json() for p in self.pending],
            "clumps": [c.to_json() for c in self.clumps],
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
        clumps = [ClumpRef.from_json(c) for c in rec.get("clumps", [])]
        return cls(t0=T0, piles=piles, pending=pending, clumps=clumps)

    def piles_at(self, inc: int) -> list[PileRef]:
        return [p for p in self.piles if p.inc == inc]

    def clump_at(self, inc: int) -> ClumpRef | None:
        for c in self.clumps:
            if c.inc == inc:
                return c
        return None


@dataclass(frozen=True)
class Clock:
    n_shell: float
    i_ref: float
    e_ref: float
    pile_id: str | None
    kind: str  # pile | draft | clump | own
    x0: float = 0.0
    y0: float = 0.0


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


def clock_phase_delta(
    n0: float,
    i0: float,
    e0: float,
    n1: float,
    i1: float,
    e1: float,
    t: datetime,
    t0: datetime = T0,
) -> tuple[float, float]:
    """(dx, dy) that cancels the wrap when a clock's (n, i, e) goes 0 → 1.

    lock x subtracts (n_shell + ω̇)·(t − t0); y uses Ω̇·(t0 − epoch). Noon
    TLEs have epoch ≈ t, so both deltas are shared by the whole clock.
    Adding (dx, dy) to a lock computed at (n1, i1, e1) recovers (n0, i0, e0).
    """
    od0, ad0 = j2_rates(n0, i0, e0)
    od1, ad1 = j2_rates(n1, i1, e1)
    dt = (t - t0).total_seconds()
    # lock x = u − (n+ω̇)·(t−t0). Adding dx to the new lock recovers the old.
    dx = ((deg_per_sec(n1) + ad1) - (deg_per_sec(n0) + ad0)) * dt
    # y = Ω + Ω̇·(t0−epoch) ≈ Ω − Ω̇·(t−t0) when epoch≈t.
    dy = (od1 - od0) * dt
    return dx, dy


def _apply_phase(target, n: float, i: float, e: float, t: datetime) -> None:
    """Move target's (n, i, e) to the new values and absorb the wrap into x0/y0."""
    dx, dy = clock_phase_delta(target.n, target.i, target.e, n, i, e, t)
    target.x0 = (target.x0 + dx) % 360.0
    target.y0 = (target.y0 + dy) % 360.0
    target.n = n
    target.i = i
    target.e = e


def _inherit_clump_phase(pile: PileRef, refs: ShellRefs, t: datetime) -> None:
    clump = refs.clump_at(pile.inc)
    if clump is None:
        return
    dx, dy = clock_phase_delta(clump.n, clump.i, clump.e, pile.n, pile.i, pile.e, t)
    pile.x0 = (clump.x0 + dx) % 360.0
    pile.y0 = (clump.y0 + dy) % 360.0


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
        x0=0.0,
        y0=0.0,
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
    After freeze, matched piles refine (n, i, e) to today's median and
    absorb the wrap into x0/y0. A new freeze inherits the clump phase.
    """
    stats = [_peak_stats(sh, members) for sh, members in detected]
    t = noon_utc(_day(day))
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
                _inherit_clump_phase(pile, refs, t)
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

    for di, pile in matched.items():
        _km, n, i, e = stats[di]
        _apply_phase(pile, n, i, e, t)

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
    """Closest pile by |Δn| within PILE_MATCH_N. None if every pile is farther."""
    if not frozen:
        return None
    closest = min(frozen, key=lambda p: abs(sat.mean_motion - p.n))
    if abs(sat.mean_motion - closest.n) > PILE_MATCH_N:
        return None
    return closest


def _clump_clock(unmatched: list[Sat], refs: ShellRefs, inc: int, t: datetime) -> Clock:
    """One shared clock: daily median n/i/e of unmatched sats at this inclination.

    Persists (n, i, e, x0, y0) on refs so a day-to-day n change does not wrap.
    """
    n = _median([s.mean_motion for s in unmatched])
    i = _median([s.inclination for s in unmatched])
    e = _median([s.ecc for s in unmatched])
    prev = refs.clump_at(inc)
    if prev is None:
        refs.clumps.append(ClumpRef(inc=inc, n=n, i=i, e=e, x0=0.0, y0=0.0))
        x0 = y0 = 0.0
    else:
        _apply_phase(prev, n, i, e, t)
        x0, y0 = prev.x0, prev.y0
    return Clock(n, i, e, None, "clump", x0, y0)


def assign_clocks(
    sats: list[Sat],
    refs: ShellRefs,
    day: str,
) -> dict[int, Clock]:
    """Assign a clock to each sat. Stable tight piles freeze into refs.

    CLOCK_MIN_COUNT gates creating a new freeze only. Once a pile exists it
    stays a valid clock; today's occupancy does not revoke it. A sat uses a
    pile's n/i/e only when |n_sat − n_pile| ≤ PILE_MATCH_N (kind=pile if in
    today's matched members, else kind=draft). Never assign a pile clock
    when |Δn| > PILE_MATCH_N, and never draft leftovers onto a far shell.
    Unmatched sats at one inclination share one kind=clump clock (daily
    median n, i, e) with a persisted phase. Matched piles refine n/i/e to
    today's median and absorb Δn·(t−t0) into x0/y0. Odd-inclination loners
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

        leftovers: list[Sat] = []
        for s in group:
            pile = sat_pile.get(s.norad_id)
            if pile is not None and abs(s.mean_motion - pile.n) <= PILE_MATCH_N:
                clocks[s.norad_id] = Clock(
                    pile.n, pile.i, pile.e, pile.id, "pile", pile.x0, pile.y0
                )
            else:
                leftovers.append(s)
        unmatched: list[Sat] = []
        for s in leftovers:
            closest = _closest_pile(s, frozen_here)
            if closest is not None:
                clocks[s.norad_id] = Clock(
                    closest.n, closest.i, closest.e, closest.id, "draft",
                    closest.x0, closest.y0,
                )
            else:
                unmatched.append(s)
        if unmatched:
            clump = _clump_clock(unmatched, refs, inc, noon_utc(_day(day)))
            for s in unmatched:
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
    x, y = lock_xy(
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
    return (x + clock.x0) % 360.0, (y + clock.y0) % 360.0


def frame_noon(day: date | datetime | str) -> datetime:
    if isinstance(day, str):
        return noon_utc(date.fromisoformat(day[:10]))
    return noon_utc(day)
