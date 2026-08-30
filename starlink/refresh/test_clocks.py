"""Pile freeze, draft-lock, and new-pile-on-lower."""

from __future__ import annotations

import unittest
from datetime import datetime

from refresh.clocks import PILE_MATCH_KM, ShellRefs, assign_clocks
from refresh.orbit import altitude_km
from refresh.parse import Sat


def _sat(
    norad: int,
    n: float,
    inc: float,
    *,
    e: float = 1e-4,
    raan: float = 10.0,
    argp: float = 20.0,
    m: float = 30.0,
    name: str = "",
) -> Sat:
    return Sat(
        name=name or f"STARLINK-{norad}",
        norad_id=norad,
        epoch=datetime(2025, 6, 29, 12, 0, 0),
        inclination=inc,
        raan=raan,
        argp=argp,
        mean_anomaly=m,
        ecc=e,
        mean_motion=n,
        altitude_km=altitude_km(n, e),
    )


def _pile_sats(n: float, inc: float, count: int, start_id: int) -> list[Sat]:
    return [_sat(start_id + i, n, inc) for i in range(count)]


class TestClocks(unittest.TestCase):
    def test_first_tight_pile_freezes_and_does_not_update(self):
        n = 15.301912
        inc = 53.1604
        refs = ShellRefs()
        day1 = _pile_sats(n, inc, 40, 58000)
        clocks = assign_clocks(day1, refs, "2025-06-29")
        self.assertEqual(len(refs.piles), 1)
        pile = refs.piles[0]
        self.assertEqual(pile.inc, 53)
        self.assertAlmostEqual(pile.n, n, places=6)
        self.assertEqual(clocks[58000].kind, "pile")
        self.assertEqual(clocks[58000].pile_id, pile.id)
        frozen_n, frozen_i, frozen_e = pile.n, pile.i, pile.e

        day2 = _pile_sats(n + 0.002, inc + 0.05, 40, 58000)
        assign_clocks(day2, refs, "2025-06-30")
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(refs.piles[0].n, frozen_n)
        self.assertEqual(refs.piles[0].i, frozen_i)
        self.assertEqual(refs.piles[0].e, frozen_e)

    def test_raiser_draft_locks_to_largest_pile(self):
        n_shell = 15.301912
        n_low = 15.50  # lower altitude / higher mean motion
        refs = ShellRefs()
        pile = _pile_sats(n_shell, 53.16, 40, 58000)
        raiser = _sat(59000, n_low, 53.10)
        clocks = assign_clocks(pile + [raiser], refs, "2025-07-01")
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(clocks[59000].kind, "draft")
        self.assertEqual(clocks[59000].pile_id, refs.piles[0].id)
        self.assertEqual(clocks[59000].n_shell, refs.piles[0].n)
        self.assertNotAlmostEqual(raiser.mean_motion, clocks[59000].n_shell, places=3)

    def test_lowered_shell_is_new_pile(self):
        n_high = 15.301912  # ~475 km
        # ~550 km circular
        n_550 = 15.064
        self.assertGreater(altitude_km(n_550, 0.0), altitude_km(n_high, 0.0) + 50)
        refs = ShellRefs()
        assign_clocks(_pile_sats(n_high, 53.16, 40, 1000), refs, "2020-01-01")
        self.assertEqual(len(refs.piles), 1)
        first_id = refs.piles[0].id
        first_km = refs.piles[0].km
        assign_clocks(_pile_sats(n_550, 53.16, 40, 1000), refs, "2021-01-01")
        self.assertEqual(len(refs.piles), 2)
        self.assertNotEqual(refs.piles[1].id, first_id)
        self.assertGreater(abs(refs.piles[1].km - first_km), PILE_MATCH_KM)

    def test_early_clump_uses_daily_median(self):
        # Fewer than detect_peaks min_count (25) → no pile yet.
        refs = ShellRefs()
        clump = _pile_sats(15.20, 53.05, 10, 44235)
        clocks = assign_clocks(clump, refs, "2019-05-24")
        self.assertEqual(refs.piles, [])
        self.assertEqual(clocks[44235].kind, "clump")
        self.assertIsNone(clocks[44235].pile_id)
        self.assertAlmostEqual(clocks[44235].n_shell, 15.20, places=6)


if __name__ == "__main__":
    unittest.main()
