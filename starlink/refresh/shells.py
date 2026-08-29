"""Inclination windows and altitude-shell peak detection."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from refresh.parse import Sat

INC_WINDOWS: dict[int, tuple[float, float]] = {
    43: (41.0, 45.0),
    53: (51.0, 56.0),
    70: (68.0, 72.0),
    97: (96.0, 99.0),
}

# Measured on the 2026-08-28 morning 53° snapshot (1 km histogram).
KNOWN_SHELLS: dict[int, list[tuple[int, float, float]]] = {
    53: [
        (360, 355.0, 362.0),
        (460, 457.0, 461.0),
        (463, 461.0, 464.0),
        (465, 464.0, 468.0),
        (471, 469.0, 473.0),
        (540, 535.0, 542.0),
    ],
}


@dataclass(frozen=True)
class Shell:
    peak_km: int | None  # None = all altitudes
    lo: float
    hi: float  # half-open [lo, hi)

    @property
    def label(self) -> str:
        return "all" if self.peak_km is None else str(self.peak_km)


def filter_inclination(sats: list[Sat], inc: int | str) -> list[Sat]:
    if inc == "all":
        return list(sats)
    lo, hi = INC_WINDOWS[int(inc)]
    return [s for s in sats if lo <= s.inclination <= hi]


def resolve_shells(inc: int | str, sats: list[Sat], shell_arg: str) -> list[Shell]:
    if shell_arg == "all":
        return [Shell(None, float("-inf"), float("inf"))]
    catalog = _catalog(inc, sats)
    if shell_arg == "auto":
        return catalog
    km = float(shell_arg)
    for sh in catalog:
        if sh.lo <= km < sh.hi:
            return [sh]
    if catalog:
        return [min(catalog, key=lambda sh: abs((sh.peak_km or 0) - km))]
    return [Shell(int(round(km)), km - 3.0, km + 3.0)]


def _catalog(inc: int | str, sats: list[Sat]) -> list[Shell]:
    if inc != "all" and int(inc) in KNOWN_SHELLS:
        return [Shell(pk, lo, hi) for pk, lo, hi in KNOWN_SHELLS[int(inc)]]
    return detect_peaks([s.altitude_km for s in sats])


def detect_peaks(altitudes: list[float], min_count: int = 25) -> list[Shell]:
    """1 km histogram; keep bins that are a clear local peak."""
    if not altitudes:
        return []
    alts = np.asarray(altitudes, dtype=float)
    lo = int(np.floor(alts.min()))
    hi = int(np.ceil(alts.max())) + 1
    edges = np.arange(lo, hi + 1, 1, dtype=int)
    hist, _ = np.histogram(alts, bins=edges)
    n = len(hist)
    idxs: list[int] = []
    for i in range(n):
        left = hist[i - 1] if i else 0
        right = hist[i + 1] if i + 1 < n else 0
        if hist[i] >= min_count and hist[i] >= left and hist[i] > right:
            idxs.append(i)

    thresh = max(min_count // 4, 3)
    shells: list[Shell] = []
    for k, i in enumerate(idxs):
        left_bound = 0 if k == 0 else (idxs[k - 1] + i) // 2 + 1
        right_bound = n - 1 if k + 1 == len(idxs) else (i + idxs[k + 1]) // 2
        left_i, right_i = i, i
        while left_i > left_bound and hist[left_i - 1] >= thresh:
            left_i -= 1
        while right_i < right_bound and hist[right_i + 1] >= thresh:
            right_i += 1
        shells.append(Shell(int(edges[i]), float(edges[left_i]), float(edges[right_i] + 1)))
    return shells


def in_shell(sat: Sat, shell: Shell) -> bool:
    return shell.lo <= sat.altitude_km < shell.hi
