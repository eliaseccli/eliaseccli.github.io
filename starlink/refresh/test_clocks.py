"""Pile freeze after 5 stable days; only 50+ piles are active shells today."""

from __future__ import annotations

import inspect
import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

from refresh.clocks import (
    CLOCK_MIN_COUNT,
    PILE_MATCH_N,
    STABLE_DAYS,
    PendingPile,
    ShellRefs,
    assign_clocks,
)
from refresh.shells import detect_peaks, listed_shells
from refresh.orbit import altitude_km
from refresh.parse import Sat

# Freeze tests use this many sats so the clump clears CLOCK_MIN_COUNT.
FREEZE_N = 50

N_475 = 15.301912  # ~475 km
N_550 = 15.054  # ~550 km
N_540 = 15.084  # ~541 km (operational 540-class)
N_460 = 15.353383
N_463 = 15.343284
N_465 = 15.336558


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


def _iso(start: str, plus: int) -> str:
    return (date.fromisoformat(start) + timedelta(days=plus)).isoformat()


def _hold(
    refs: ShellRefs,
    n: float,
    inc: float,
    start_day: str,
    days: int,
    *,
    count: int = FREEZE_N,
    start_id: int = 58000,
    extra: list[Sat] | None = None,
) -> dict[int, object]:
    clocks: dict[int, object] = {}
    for i in range(days):
        sats = _pile_sats(n, inc, count, start_id)
        if extra:
            sats = sats + extra
        clocks = assign_clocks(sats, refs, _iso(start_day, i))
    return clocks


class TestClocks(unittest.TestCase):
    def test_first_tight_pile_freezes_only_after_five_stable_days(self):
        n = N_475
        inc = 53.1604
        refs = ShellRefs()
        for i in range(STABLE_DAYS - 1):
            clocks = assign_clocks(_pile_sats(n, inc, FREEZE_N, 58000), refs, _iso("2025-06-29", i))
            self.assertEqual(refs.piles, [])
            self.assertEqual(len(refs.pending), 1)
            self.assertEqual(refs.pending[0].streak, i + 1)
            self.assertEqual(clocks[58000].kind, "clump")
            self.assertAlmostEqual(clocks[58000].n_shell, n, places=6)

        clocks = assign_clocks(_pile_sats(n, inc, FREEZE_N, 58000), refs, _iso("2025-06-29", 4))
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(refs.pending, [])
        pile = refs.piles[0]
        self.assertEqual(pile.inc, 53)
        self.assertAlmostEqual(pile.n, n, places=6)
        self.assertEqual(clocks[58000].kind, "pile")
        self.assertEqual(clocks[58000].pile_id, pile.id)
        frozen_n, frozen_i, frozen_e = pile.n, pile.i, pile.e

        day6 = _pile_sats(n + 0.002, inc + 0.05, FREEZE_N, 58000)
        assign_clocks(day6, refs, _iso("2025-06-29", 5))
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(refs.piles[0].n, frozen_n)
        self.assertEqual(refs.piles[0].i, frozen_i)
        self.assertEqual(refs.piles[0].e, frozen_e)

    def test_close_n_drafts_to_nearest_frozen_pile(self):
        n_shell = N_475
        n_close = n_shell + 0.003
        self.assertLessEqual(abs(n_close - n_shell), PILE_MATCH_N)
        refs = ShellRefs()
        raiser = _sat(59000, n_close, 53.10)
        clocks = _hold(refs, n_shell, 53.16, "2025-07-01", STABLE_DAYS, extra=[raiser])
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(clocks[59000].kind, "draft")
        self.assertEqual(clocks[59000].pile_id, refs.piles[0].id)
        self.assertEqual(clocks[59000].n_shell, refs.piles[0].n)
        self.assertEqual(clocks[58000].kind, "pile")

    def test_clock_min_count_is_50(self):
        self.assertEqual(CLOCK_MIN_COUNT, 50)
        self.assertEqual(inspect.signature(detect_peaks).parameters["min_count"].default, 25)

    def test_lowered_shell_is_new_pile_after_five_stable_days(self):
        n_high = N_475
        n_550 = 15.064
        self.assertGreater(altitude_km(n_550, 0.0), altitude_km(n_high, 0.0) + 50)
        self.assertGreater(abs(n_550 - n_high), PILE_MATCH_N)
        refs = ShellRefs()
        clocks = _hold(refs, n_high, 53.16, "2020-01-01", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(clocks[1000].kind, "pile")
        first_id = refs.piles[0].id
        first_n = refs.piles[0].n

        for i in range(STABLE_DAYS - 1):
            clocks = assign_clocks(
                _pile_sats(n_550, 53.16, FREEZE_N, 1000), refs, _iso("2021-01-01", i)
            )
            self.assertEqual(len(refs.piles), 1)
            self.assertEqual(clocks[1000].kind, "clump")
            self.assertIsNone(clocks[1000].pile_id)
            self.assertAlmostEqual(clocks[1000].n_shell, n_550, places=6)
            self.assertNotEqual(first_id, clocks[1000].pile_id)
            self.assertNotAlmostEqual(clocks[1000].n_shell, first_n, places=3)

        clocks = assign_clocks(_pile_sats(n_550, 53.16, FREEZE_N, 1000), refs, _iso("2021-01-01", 4))
        self.assertEqual(len(refs.piles), 2)
        self.assertNotEqual(refs.piles[1].id, first_id)
        self.assertGreater(abs(refs.piles[1].n - first_n), PILE_MATCH_N)
        self.assertEqual(clocks[1000].kind, "pile")
        self.assertEqual(clocks[1000].pile_id, refs.piles[1].id)

    def test_descent_ladder_does_not_freeze(self):
        # One-week smear: n/km change each day (Nov 2019 junk ladder).
        ladder_n = [15.054, 15.064, 15.084, 15.094, 15.104, 15.114, 15.124]
        refs = ShellRefs()
        for i, n in enumerate(ladder_n):
            if i:
                self.assertGreater(abs(n - ladder_n[i - 1]), PILE_MATCH_N)
            clocks = assign_clocks(_pile_sats(n, 53.16, FREEZE_N, 1000), refs, _iso("2019-11-24", i))
            self.assertEqual(refs.piles, [])
            self.assertEqual(clocks[1000].kind, "clump")
        self.assertEqual(refs.piles, [])
        self.assertTrue(refs.pending)
        self.assertTrue(all(p.streak == 1 for p in refs.pending))

    def test_slow_climb_004_per_day_does_not_freeze(self):
        # n0 is identity; chasing n would freeze a 0.004/day climb.
        n0 = N_550
        refs = ShellRefs()
        assign_clocks(_pile_sats(n0, 53.16, FREEZE_N, 1000), refs, _iso("2020-01-01", 0))
        self.assertAlmostEqual(refs.pending[0].n, n0, places=6)
        assign_clocks(_pile_sats(n0 + 0.004, 53.16, FREEZE_N, 1000), refs, _iso("2020-01-01", 1))
        self.assertEqual(refs.piles, [])
        self.assertEqual(refs.pending[0].n, n0)
        self.assertEqual(refs.pending[0].streak, 2)
        for i in range(2, 8):
            n = n0 + 0.004 * i
            clocks = assign_clocks(_pile_sats(n, 53.16, FREEZE_N, 1000), refs, _iso("2020-01-01", i))
            self.assertEqual(refs.piles, [])
            self.assertEqual(clocks[1000].kind, "clump")
        self.assertEqual(refs.piles, [])
        self.assertTrue(all(p.streak < STABLE_DAYS for p in refs.pending))
        today_n = n0 + 0.004 * 7
        self.assertTrue(all(abs(p.n - today_n) > 1e-9 for p in refs.pending))

    def test_three_days_skip_one_then_two_more_freezes(self):
        refs = ShellRefs()
        for i in (0, 1, 2):
            assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), refs, _iso("2025-06-29", i))
        self.assertEqual(refs.piles, [])
        self.assertEqual(refs.pending[0].streak, 3)
        n0 = refs.pending[0].n
        # Skip 2025-07-02 (day +3). Next sightings are +4 and +5.
        clocks = assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), refs, _iso("2025-06-29", 4))
        self.assertEqual(refs.piles, [])
        self.assertEqual(refs.pending[0].streak, 4)
        self.assertEqual(refs.pending[0].n, n0)
        clocks = assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), refs, _iso("2025-06-29", 5))
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(refs.pending, [])
        self.assertEqual(clocks[58000].kind, "pile")
        self.assertAlmostEqual(refs.piles[0].n, n0, places=6)

    def test_smear_541_then_540_same_n_is_one_pile(self):
        refs = ShellRefs()
        _hold(refs, N_540, 53.16, "2019-11-26", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 1)
        self.assertAlmostEqual(refs.piles[0].n, N_540, places=6)
        # 540-class operational with |Δn| <= 0.005 of the smear freeze.
        n_close = N_540 + 0.003
        self.assertLessEqual(abs(n_close - N_540), PILE_MATCH_N)
        clocks = assign_clocks(_pile_sats(n_close, 53.16, FREEZE_N, 1000), refs, "2019-12-01")
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(clocks[1000].kind, "pile")
        self.assertEqual(clocks[1000].pile_id, refs.piles[0].id)
        self.assertEqual(clocks[1000].n_shell, refs.piles[0].n)

    def test_550_then_540_different_n_are_two_piles(self):
        self.assertGreater(abs(N_540 - N_550), PILE_MATCH_N)
        refs = ShellRefs()
        _hold(refs, N_550, 53.16, "2019-06-19", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 1)
        self.assertAlmostEqual(refs.piles[0].n, N_550, places=6)
        clocks = _hold(refs, N_540, 53.16, "2020-12-01", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 2)
        self.assertGreater(abs(refs.piles[1].n - refs.piles[0].n), PILE_MATCH_N)
        self.assertEqual(clocks[1000].kind, "pile")
        self.assertEqual(clocks[1000].pile_id, refs.piles[1].id)

    def test_460_463_465_stay_separate(self):
        self.assertGreater(abs(N_460 - N_463), 0.01)  # ~0.010 > 0.005
        self.assertGreater(abs(N_460 - N_463), PILE_MATCH_N)
        self.assertGreater(abs(N_463 - N_465), PILE_MATCH_N)
        self.assertGreater(abs(N_460 - N_465), PILE_MATCH_N)
        refs = ShellRefs()
        clocks = {}
        for i in range(STABLE_DAYS):
            sats = (
                _pile_sats(N_460, 53.16, FREEZE_N, 1000)
                + _pile_sats(N_463, 53.16, FREEZE_N, 2000)
                + _pile_sats(N_465, 53.16, FREEZE_N, 3000)
            )
            clocks = assign_clocks(sats, refs, _iso("2024-07-20", i))
        self.assertEqual(len(refs.piles), 3)
        ns = sorted(p.n for p in refs.piles)
        self.assertGreater(ns[1] - ns[0], PILE_MATCH_N)
        self.assertGreater(ns[2] - ns[1], PILE_MATCH_N)
        self.assertEqual(clocks[1000].kind, "pile")
        self.assertEqual(clocks[2000].kind, "pile")
        self.assertEqual(clocks[3000].kind, "pile")
        self.assertEqual(len({clocks[1000].pile_id, clocks[2000].pile_id, clocks[3000].pile_id}), 3)

    def test_twenty_sat_tight_peak_does_not_freeze(self):
        n = 15.1435
        inc = 97.6
        refs = ShellRefs()
        group = _pile_sats(n, inc, 20, 47000)
        self.assertLess(len(group), CLOCK_MIN_COUNT)
        self.assertEqual(listed_shells(97, group), [])
        for i in range(STABLE_DAYS):
            clocks = assign_clocks(_pile_sats(n, inc, 20, 47000), refs, _iso("2021-02-01", i))
            self.assertEqual(refs.piles, [])
            self.assertEqual(refs.pending, [])
            self.assertEqual(clocks[47000].kind, "clump")
            self.assertAlmostEqual(clocks[47000].n_shell, n, places=6)
        self.assertEqual(listed_shells(97, _pile_sats(n, inc, 20, 47000)), [])

    def test_thirty_sat_peak_lists_but_does_not_freeze(self):
        # detect_peaks min_count 25 still lists the km checkbox; clocks need 50.
        n = 15.1435
        group = _pile_sats(n, 97.6, 30, 47000)
        self.assertTrue(listed_shells(97, group))
        refs = ShellRefs()
        for i in range(STABLE_DAYS):
            clocks = assign_clocks(_pile_sats(n, 97.6, 30, 47000), refs, _iso("2021-02-01", i))
        self.assertEqual(refs.piles, [])
        self.assertEqual(refs.pending, [])
        self.assertEqual(clocks[47000].kind, "clump")

    def test_seven_tight_sats_do_not_pending(self):
        refs = ShellRefs()
        clocks = assign_clocks(_pile_sats(15.1435, 97.6, 7, 47000), refs, "2021-02-01")
        self.assertEqual(refs.piles, [])
        self.assertEqual(refs.pending, [])
        self.assertEqual(clocks[47000].kind, "clump")

    def test_pending_persists_across_shell_refs_json_roundtrip(self):
        refs = ShellRefs()
        assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), refs, "2025-06-29")
        self.assertEqual(refs.piles, [])
        self.assertEqual(len(refs.pending), 1)
        self.assertEqual(refs.pending[0].streak, 1)

        # Same-day Action re-run must not increment the streak.
        assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), refs, "2025-06-29")
        self.assertEqual(refs.pending[0].streak, 1)

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "shell_refs.json"
            refs.save(path)
            rec = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("pending", rec)
            self.assertEqual(len(rec["pending"]), 1)
            self.assertEqual(
                set(rec["pending"][0]),
                {"inc", "km", "n", "i", "e", "streak", "last"},
            )
            loaded = ShellRefs.load(path)
            self.assertEqual(loaded.piles, [])
            self.assertEqual(len(loaded.pending), 1)
            self.assertEqual(loaded.pending[0].streak, 1)
            self.assertEqual(loaded.pending[0].last, "2025-06-29")
            self.assertAlmostEqual(loaded.pending[0].n, N_475, places=6)

            for i in range(1, STABLE_DAYS - 1):
                assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), loaded, _iso("2025-06-29", i))
                loaded.save(path)
                loaded = ShellRefs.load(path)
                self.assertEqual(loaded.piles, [])
                self.assertEqual(loaded.pending[0].streak, i + 1)

            assign_clocks(_pile_sats(N_475, 53.16, FREEZE_N, 58000), loaded, _iso("2025-06-29", 4))
            loaded.save(path)
            done = ShellRefs.load(path)
            self.assertEqual(len(done.piles), 1)
            self.assertEqual(done.pending, [])

    def test_load_shell_refs_without_pending_key(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "shell_refs.json"
            path.write_text(
                json.dumps({"t0": "2019-05-24T12:00:00", "piles": []}) + "\n",
                encoding="utf-8",
            )
            refs = ShellRefs.load(path)
            self.assertEqual(refs.piles, [])
            self.assertEqual(refs.pending, [])

    def test_pending_dataclass_roundtrip(self):
        p = PendingPile(inc=53, km=475, n=N_475, i=53.16, e=1e-4, streak=3, last="2025-07-01")
        q = PendingPile.from_json(p.to_json())
        self.assertEqual(q, p)

    def test_forty_unmatched_draft_to_closest_pile(self):
        refs = ShellRefs()
        _hold(refs, 15.70, 97.65, "2022-07-22", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 1)
        pile = refs.piles[0]
        leftovers = _pile_sats(15.01, 97.65, 40, 90000)
        self.assertGreater(abs(15.01 - pile.n), PILE_MATCH_N)
        self.assertLess(len(leftovers), CLOCK_MIN_COUNT)
        clocks = assign_clocks(
            _pile_sats(15.70, 97.65, FREEZE_N, 1000) + leftovers, refs, "2022-07-27"
        )
        self.assertEqual(clocks[1000].kind, "pile")
        for s in leftovers:
            rec = clocks[s.norad_id]
            self.assertEqual(rec.kind, "draft")
            self.assertEqual(rec.pile_id, pile.id)
            self.assertEqual(rec.n_shell, pile.n)
            self.assertEqual(rec.i_ref, pile.i)
            self.assertEqual(rec.e_ref, pile.e)

    def test_sixty_leftovers_draft_to_active_shell(self):
        refs = ShellRefs()
        _hold(refs, 15.70, 97.65, "2022-07-22", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 1)
        pile = refs.piles[0]
        leftovers = _pile_sats(15.01, 97.60, 30, 90000) + _pile_sats(15.40, 97.70, 30, 91000)
        self.assertGreater(abs(15.01 - 15.70), PILE_MATCH_N)
        self.assertGreater(abs(15.40 - 15.70), PILE_MATCH_N)
        self.assertGreaterEqual(len(leftovers), CLOCK_MIN_COUNT)
        clocks = assign_clocks(
            _pile_sats(15.70, 97.65, FREEZE_N, 1000) + leftovers, refs, "2022-07-27"
        )
        self.assertEqual(clocks[1000].kind, "pile")
        for s in leftovers:
            rec = clocks[s.norad_id]
            self.assertEqual(rec.kind, "draft")
            self.assertEqual(rec.pile_id, pile.id)
            self.assertEqual(rec.n_shell, pile.n)

    def test_shrunk_pile_members_draft_to_closest_50(self):
        # Frozen when big, then 20 sats at that n: not an active shell today.
        refs = ShellRefs()
        _hold(refs, 15.70, 97.65, "2022-07-22", STABLE_DAYS, start_id=1000)
        _hold(refs, 15.01, 97.65, "2022-08-01", STABLE_DAYS, start_id=2000)
        self.assertEqual(len(refs.piles), 2)
        shrunk = next(p for p in refs.piles if abs(p.n - 15.70) < 1e-6)
        big = next(p for p in refs.piles if abs(p.n - 15.01) < 1e-6)
        small = _pile_sats(15.70, 97.65, 20, 1000)
        clocks = assign_clocks(
            small + _pile_sats(15.01, 97.65, FREEZE_N, 2000), refs, "2022-08-06"
        )
        self.assertEqual(len(refs.piles), 2)
        self.assertEqual(clocks[2000].kind, "pile")
        self.assertEqual(clocks[2000].pile_id, big.id)
        self.assertEqual(clocks[2000].n_shell, big.n)
        for s in small:
            rec = clocks[s.norad_id]
            self.assertEqual(rec.kind, "draft")
            self.assertEqual(rec.pile_id, big.id)
            self.assertEqual(rec.n_shell, big.n)
            self.assertNotEqual(rec.pile_id, shrunk.id)
            self.assertNotAlmostEqual(rec.n_shell, shrunk.n, places=3)

    def test_no_active_shell_leftovers_share_clump(self):
        refs = ShellRefs()
        _hold(refs, 15.70, 97.65, "2022-07-22", STABLE_DAYS, start_id=1000)
        self.assertEqual(len(refs.piles), 1)
        leftover_n = 15.01
        leftover_n2 = 15.40
        leftovers = _pile_sats(leftover_n, 97.60, 20, 90000) + _pile_sats(leftover_n2, 97.70, 20, 91000)
        clocks = assign_clocks(leftovers, refs, "2022-07-27")
        self.assertEqual(len(refs.piles), 1)
        self.assertEqual(clocks[90000].kind, "clump")
        self.assertIsNone(clocks[90000].pile_id)
        self.assertEqual(clocks[90000].n_shell, clocks[91000].n_shell)
        self.assertAlmostEqual(clocks[90000].n_shell, (leftover_n + leftover_n2) / 2.0, places=6)
        self.assertNotAlmostEqual(clocks[90000].n_shell, refs.piles[0].n, places=3)

    def test_odd_inclination_loner_stays_own(self):
        refs = ShellRefs()
        loner = _sat(80000, 15.20, 30.0)
        clocks = assign_clocks([loner], refs, "2019-05-24")
        self.assertEqual(clocks[80000].kind, "own")
        self.assertAlmostEqual(clocks[80000].n_shell, 15.20, places=6)
        self.assertAlmostEqual(clocks[80000].i_ref, 30.0, places=6)
        self.assertIsNone(clocks[80000].pile_id)


if __name__ == "__main__":
    unittest.main()
