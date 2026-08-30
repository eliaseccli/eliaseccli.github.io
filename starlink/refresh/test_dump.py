"""Today-view dump uses J2 locked_xy + lock_state, not position_at."""

from __future__ import annotations

import inspect
import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from refresh.clocks import Clock, ShellRefs, locked_xy
from refresh import dump as dump_mod
from refresh.dump import dump_sats
from refresh.lock import LockState, apply_locks
from refresh.orbit import altitude_km, position_at
from refresh.parse import Sat


def _sat(norad: int, n: float, inc: float) -> Sat:
    return Sat(
        name=f"STARLINK-{norad}",
        norad_id=norad,
        epoch=datetime(2026, 8, 29, 11, 27, 8),
        inclination=inc,
        raan=40.0,
        argp=50.0,
        mean_anomaly=60.0,
        ecc=1e-4,
        mean_motion=n,
        altitude_km=altitude_km(n, 1e-4),
    )


class TestDump(unittest.TestCase):
    def test_dump_uses_locked_xy_not_position_at(self):
        sat = _sat(58000, 15.301912, 53.16)
        noon = datetime(2026, 8, 30, 12, 0, 0)
        clock = Clock(sat.mean_motion, sat.inclination, sat.ecc, None, "own")
        want_x, want_y = locked_xy(sat, clock, noon)
        magic_t = sat.epoch
        magic_x, magic_y = position_at(sat, magic_t)
        self.assertGreater(min(abs(want_x - magic_x), 360.0 - abs(want_x - magic_x)), 1.0)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            timeline = root / "timeline"
            timeline.mkdir()
            ShellRefs().save(timeline / "shell_refs.json")
            LockState().save(timeline / "lock_state.json")
            out = root / "sats.json"
            src = inspect.getsource(dump_mod)
            self.assertIn("apply_locks", src)
            self.assertNotIn("position_at", src)
            payload = dump_sats(
                out,
                timeline_dir=timeline,
                frame_date=date(2026, 8, 30),
                sats=[sat],
            )
            self.assertEqual(payload["n"], 1)
            rec = payload["sats"][0]
            self.assertAlmostEqual(rec["x"], round(want_x, 4), places=4)
            self.assertAlmostEqual(rec["y"], round(want_y, 4), places=4)
            self.assertNotAlmostEqual(rec["x"], round(magic_x, 4), places=2)
            written = json.loads(out.read_text(encoding="utf-8"))
            self.assertAlmostEqual(written["sats"][0]["x"], rec["x"], places=4)

    def test_dump_reuses_same_day_lock_state(self):
        sat = _sat(58000, 15.301912, 53.16)
        noon = datetime(2026, 8, 30, 12, 0, 0)
        clock = Clock(sat.mean_motion, sat.inclination, sat.ecc, None, "own")
        state = LockState()
        apply_locks([sat], {sat.norad_id: clock}, noon, state, "2026-08-30")
        state.sats[sat.norad_id].x = 111.1111
        state.sats[sat.norad_id].y = 222.2222
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            timeline = root / "timeline"
            timeline.mkdir()
            ShellRefs().save(timeline / "shell_refs.json")
            state.save(timeline / "lock_state.json")
            payload = dump_sats(
                root / "sats.json",
                timeline_dir=timeline,
                frame_date=date(2026, 8, 30),
                sats=[sat],
            )
            rec = payload["sats"][0]
            self.assertAlmostEqual(rec["x"], 111.1111, places=4)
            self.assertAlmostEqual(rec["y"], 222.2222, places=4)


if __name__ == "__main__":
    unittest.main()
