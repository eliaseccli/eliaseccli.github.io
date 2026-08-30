"""Clock-switch offsets and pile-only circular EMA."""

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
    hold_own_clock,
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
    def test_clock_switch_applies_offset_to_match_previous(self):
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
        self.assertAlmostEqual(xy1[sat.norad_id][0], prev_x, places=9)
        self.assertAlmostEqual(xy1[sat.norad_id][1], prev_y, places=9)
        rec = state.sats[sat.norad_id]
        self.assertEqual(rec.kind, "pile")
        self.assertEqual(rec.pile_id, "97-358")
        self.assertAlmostEqual((raw_x + rec.ox) % 360.0, prev_x, places=9)
        self.assertAlmostEqual((raw_y + rec.oy) % 360.0, prev_y, places=9)

    def test_ema_only_for_kind_pile(self):
        sat = _sat(58000, 15.301912, 53.16)
        t0 = datetime(2025, 6, 29, 12, 0, 0)
        t1 = datetime(2025, 6, 30, 12, 0, 0)
        pile = Clock(15.301912, 53.16, 1e-4, "53-475", "pile")
        own = Clock(15.301912, 53.16, 1e-4, None, "own")
        draft = Clock(15.301912, 53.16, 1e-4, "53-475", "draft")

        state = LockState()
        apply_locks([sat], {sat.norad_id: pile}, t0, state, "2025-06-29")
        prev = state.sats[sat.norad_id]
        raw_x, raw_y = locked_xy(sat, pile, t1)
        adj_x = (raw_x + prev.ox) % 360.0
        adj_y = (raw_y + prev.oy) % 360.0
        want_x = circular_ema(prev.x, adj_x, EMA_ALPHA)
        want_y = circular_ema(prev.y, adj_y, EMA_ALPHA)
        xy = apply_locks([sat], {sat.norad_id: pile}, t1, state, "2025-06-30")
        self.assertAlmostEqual(xy[sat.norad_id][0], want_x, places=9)
        self.assertAlmostEqual(xy[sat.norad_id][1], want_y, places=9)
        self.assertAlmostEqual(EMA_ALPHA, 0.4)

        state_own = LockState()
        apply_locks([sat], {sat.norad_id: own}, t0, state_own, "2025-06-29")
        state_own.sats[sat.norad_id].x = 0.0
        state_own.sats[sat.norad_id].y = 0.0
        prev_own = state_own.sats[sat.norad_id]
        raw_ox, raw_oy = locked_xy(sat, own, t1)
        adj_ox = (raw_ox + prev_own.ox) % 360.0
        adj_oy = (raw_oy + prev_own.oy) % 360.0
        xy_own = apply_locks([sat], {sat.norad_id: own}, t1, state_own, "2025-06-30")
        self.assertAlmostEqual(xy_own[sat.norad_id][0], adj_ox, places=9)
        self.assertAlmostEqual(xy_own[sat.norad_id][1], adj_oy, places=9)
        self.assertGreater(abs(circular_ema(0.0, adj_ox, EMA_ALPHA) - adj_ox), 1e-6)

        state_draft = LockState()
        apply_locks([sat], {sat.norad_id: draft}, t0, state_draft, "2025-06-29")
        state_draft.sats[sat.norad_id].x = 0.0
        state_draft.sats[sat.norad_id].y = 0.0
        prev_d = state_draft.sats[sat.norad_id]
        raw_dx, raw_dy = locked_xy(sat, draft, t1)
        adj_dx = (raw_dx + prev_d.ox) % 360.0
        adj_dy = (raw_dy + prev_d.oy) % 360.0
        xy_d = apply_locks([sat], {sat.norad_id: draft}, t1, state_draft, "2025-06-30")
        self.assertAlmostEqual(xy_d[sat.norad_id][0], adj_dx, places=9)
        self.assertAlmostEqual(xy_d[sat.norad_id][1], adj_dy, places=9)
        self.assertGreater(abs(circular_ema(0.0, adj_dx, EMA_ALPHA) - adj_dx), 1e-6)

    def test_own_clock_holds_first_n(self):
        sat0 = _sat(47000, 15.01, 97.6)
        sat1 = _sat(47000, 15.04, 97.6)
        own0 = Clock(15.01, 97.6, 1e-4, None, "own")
        own1 = Clock(15.04, 97.6, 1e-4, None, "own")
        held = hold_own_clock(own1, SatLock(15.01, 97.6, 1e-4, None, 0, 0, 1, 2, "own"))
        self.assertAlmostEqual(held.n_shell, 15.01, places=6)
        self.assertEqual(held.kind, "own")
        t0 = datetime(2021, 2, 5, 12, 0, 0)
        t1 = datetime(2021, 2, 6, 12, 0, 0)
        state = LockState()
        apply_locks([sat0], {47000: own0}, t0, state, "2021-02-05")
        apply_locks([sat1], {47000: own1}, t1, state, "2021-02-06")
        self.assertAlmostEqual(state.sats[47000].n, 15.01, places=6)
        self.assertEqual(state.sats[47000].kind, "own")

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
            loaded = LockState.load(path)
            self.assertEqual(loaded.day, "2021-02-05")
            self.assertAlmostEqual(loaded.sats[47000].n, 15.01, places=6)
            self.assertEqual(loaded.sats[47000].kind, "own")
            self.assertIsNone(loaded.sats[47000].pile_id)


if __name__ == "__main__":
    unittest.main()
