"""Pile-only circular EMA. No per-sat ox/oy shift. No hold_own_clock."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from refresh.clocks import Clock, locked_xy
from refresh.lock import (
    EMA_ALPHA,
    LockState,
    SatLock,
    apply_locks,
    circular_ema,
)
from refresh.orbit import altitude_km
from refresh.parse import Sat


def _sat(norad: int, n: float, inc: float, *, raan: float = 10.0, argp: float = 20.0, m: float = 30.0) -> Sat:
    return Sat(
        name=f"STARLINK-{norad}",
        norad_id=norad,
        epoch=datetime(2021, 2, 5, 12, 0, 0),
        inclination=inc,
        raan=raan,
        argp=argp,
        mean_anomaly=m,
        ecc=1e-4,
        mean_motion=n,
        altitude_km=altitude_km(n, 1e-4),
    )


class TestLock(unittest.TestCase):
    def test_clock_switch_does_not_apply_offset(self):
        sat = _sat(47000, 15.01, 97.6)
        t0 = datetime(2021, 2, 5, 12, 0, 0)
        t1 = datetime(2021, 2, 6, 12, 0, 0)
        own = Clock(15.01, 97.6, 1e-4, None, "own")
        pile = Clock(15.70, 97.65, 1e-4, "97-358", "pile")
        state = LockState()
        xy0 = apply_locks([sat], {sat.norad_id: own}, t0, state, "2021-02-05")
        prev_x, prev_y = xy0[sat.norad_id]
        raw_x, raw_y = locked_xy(sat, pile, t1)
        self.assertGreater(min(abs(raw_x - prev_x), 360.0 - abs(raw_x - prev_x)), 1.0)
        xy1 = apply_locks([sat], {sat.norad_id: pile}, t1, state, "2021-02-06")
        self.assertAlmostEqual(xy1[sat.norad_id][0], raw_x % 360.0, places=9)
        self.assertAlmostEqual(xy1[sat.norad_id][1], raw_y % 360.0, places=9)
        rec = state.sats[sat.norad_id]
        self.assertEqual(rec.kind, "pile")
        self.assertEqual(rec.pile_id, "97-358")
        self.assertEqual(rec.ox, 0.0)
        self.assertEqual(rec.oy, 0.0)
        self.assertGreater(min(abs(xy1[sat.norad_id][0] - prev_x), 360.0 - abs(xy1[sat.norad_id][0] - prev_x)), 1.0)

    def test_loaded_offsets_do_not_shift_plot(self):
        sat = _sat(47000, 15.01, 97.6)
        t = datetime(2021, 2, 6, 12, 0, 0)
        pile = Clock(15.70, 97.65, 1e-4, "97-358", "pile")
        raw_x, raw_y = locked_xy(sat, pile, t)
        state = LockState(day="2021-02-05")
        state.sats[sat.norad_id] = SatLock(
            15.01, 97.6, 1e-4, None, 123.4, 56.7, 10.0, 20.0, "own"
        )
        xy = apply_locks([sat], {sat.norad_id: pile}, t, state, "2021-02-06")
        self.assertAlmostEqual(xy[sat.norad_id][0], raw_x % 360.0, places=9)
        self.assertAlmostEqual(xy[sat.norad_id][1], raw_y % 360.0, places=9)
        self.assertEqual(state.sats[sat.norad_id].ox, 0.0)
        self.assertEqual(state.sats[sat.norad_id].oy, 0.0)

    def test_ema_only_for_kind_pile(self):
        sat = _sat(58000, 15.301912, 53.16)
        t0 = datetime(2025, 6, 29, 12, 0, 0)
        t1 = datetime(2025, 6, 30, 12, 0, 0)
        pile = Clock(15.301912, 53.16, 1e-4, "53-475", "pile")
        own = Clock(15.301912, 53.16, 1e-4, None, "own")
        draft = Clock(15.301912, 53.16, 1e-4, "53-475", "draft")
        clump = Clock(15.301912, 53.16, 1e-4, None, "clump")

        state = LockState()
        apply_locks([sat], {sat.norad_id: pile}, t0, state, "2025-06-29")
        prev = state.sats[sat.norad_id]
        raw_x, raw_y = locked_xy(sat, pile, t1)
        want_x = circular_ema(prev.x, raw_x % 360.0, EMA_ALPHA)
        want_y = circular_ema(prev.y, raw_y % 360.0, EMA_ALPHA)
        xy = apply_locks([sat], {sat.norad_id: pile}, t1, state, "2025-06-30")
        self.assertAlmostEqual(xy[sat.norad_id][0], want_x, places=9)
        self.assertAlmostEqual(xy[sat.norad_id][1], want_y, places=9)
        self.assertAlmostEqual(EMA_ALPHA, 0.4)
        self.assertEqual(state.sats[sat.norad_id].ox, 0.0)
        self.assertEqual(state.sats[sat.norad_id].oy, 0.0)

        for kind_clock in (own, draft, clump):
            state_k = LockState()
            apply_locks([sat], {sat.norad_id: kind_clock}, t0, state_k, "2025-06-29")
            state_k.sats[sat.norad_id].x = 0.0
            state_k.sats[sat.norad_id].y = 0.0
            raw_kx, raw_ky = locked_xy(sat, kind_clock, t1)
            xy_k = apply_locks([sat], {sat.norad_id: kind_clock}, t1, state_k, "2025-06-30")
            self.assertAlmostEqual(xy_k[sat.norad_id][0], raw_kx % 360.0, places=9)
            self.assertAlmostEqual(xy_k[sat.norad_id][1], raw_ky % 360.0, places=9)
            self.assertGreater(abs(circular_ema(0.0, raw_kx % 360.0, EMA_ALPHA) - (raw_kx % 360.0)), 1e-6)

    def test_no_hold_own_clock(self):
        import refresh.lock as lock_mod

        self.assertFalse(hasattr(lock_mod, "hold_own_clock"))
        sat0 = _sat(47000, 15.01, 97.6)
        sat1 = _sat(47000, 15.04, 97.6)
        own0 = Clock(15.01, 97.6, 1e-4, None, "own")
        own1 = Clock(15.04, 97.6, 1e-4, None, "own")
        t0 = datetime(2021, 2, 5, 12, 0, 0)
        t1 = datetime(2021, 2, 6, 12, 0, 0)
        state = LockState()
        apply_locks([sat0], {47000: own0}, t0, state, "2021-02-05")
        apply_locks([sat1], {47000: own1}, t1, state, "2021-02-06")
        self.assertAlmostEqual(state.sats[47000].n, 15.04, places=6)
        self.assertEqual(state.sats[47000].kind, "own")
        self.assertEqual(state.sats[47000].ox, 0.0)
        self.assertEqual(state.sats[47000].oy, 0.0)

    def test_same_day_returns_stored_xy(self):
        sat = _sat(47000, 15.01, 97.6)
        own = Clock(15.01, 97.6, 1e-4, None, "own")
        t = datetime(2021, 2, 5, 12, 0, 0)
        state = LockState()
        first = apply_locks([sat], {47000: own}, t, state, "2021-02-05")
        state.sats[47000].x = 12.345
        state.sats[47000].y = 67.89
        again = apply_locks([sat], {47000: own}, t, state, "2021-02-05")
        self.assertEqual(again[47000], (12.345, 67.89))
        self.assertNotEqual(again[47000], first[47000])

    def test_lock_state_json_roundtrip(self):
        state = LockState(day="2021-02-05")
        state.sats[47000] = SatLock(15.01, 97.6, 1e-4, None, 1.5, 2.5, 10.0, 20.0, "own")
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "lock_state.json"
            state.save(path)
            rec = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(set(rec["sats"]["47000"]), {"n", "i", "e", "pile_id", "ox", "oy", "x", "y", "kind"})
            self.assertEqual(rec["sats"]["47000"]["ox"], 0.0)
            self.assertEqual(rec["sats"]["47000"]["oy"], 0.0)
            loaded = LockState.load(path)
            self.assertEqual(loaded.day, "2021-02-05")
            self.assertAlmostEqual(loaded.sats[47000].n, 15.01, places=6)
            self.assertEqual(loaded.sats[47000].kind, "own")
            self.assertIsNone(loaded.sats[47000].pile_id)
            self.assertEqual(loaded.sats[47000].ox, 0.0)
            self.assertEqual(loaded.sats[47000].oy, 0.0)

            leftover = {
                "day": "2021-02-05",
                "sats": {
                    "47000": {
                        "n": 15.01,
                        "i": 97.6,
                        "e": 1e-4,
                        "pile_id": None,
                        "ox": 88.8,
                        "oy": 99.9,
                        "x": 10.0,
                        "y": 20.0,
                        "kind": "own",
                    }
                },
            }
            path.write_text(json.dumps(leftover), encoding="utf-8")
            ignored = LockState.load(path)
            self.assertEqual(ignored.sats[47000].ox, 0.0)
            self.assertEqual(ignored.sats[47000].oy, 0.0)


if __name__ == "__main__":
    unittest.main()
