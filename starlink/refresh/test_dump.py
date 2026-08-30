"""Today-view dump uses J2 locked_xy + lock_state, not position_at."""

from __future__ import annotations

import inspect
import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from refresh.binary import DayFrame, MonthBin, write_month
from refresh.catalog import CatalogSat, TimelineCatalog
from refresh.clocks import Clock, ShellRefs, locked_xy
from refresh import dump as dump_mod
from refresh.dump import dump_sats, last_packed_xy, overlay_packed_xy
from refresh.j2 import pack_u16, unpack_u16
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
            self.assertIn("last_packed_xy", src)
            self.assertIn("overlay_packed_xy", src)
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

    def test_last_packed_xy_reads_newest_day(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            timeline = root / "timeline"
            v1 = timeline / "v1"
            v1.mkdir(parents=True)
            catalog = TimelineCatalog(
                start="2026-08-28",
                end="2026-08-29",
                sats=[
                    CatalogSat(id=58000, name="STARLINK-58000", inc=53),
                    CatalogSat(id=58001, name="STARLINK-58001", inc=53),
                ],
            )
            catalog.save(timeline / "catalog.json")
            month = MonthBin(
                year=2026,
                month=8,
                catalog_len=2,
                first_date=20260828,
                days=[
                    DayFrame(
                        date=20260828,
                        slots=[0],
                        xs=[pack_u16(10.0)],
                        ys=[pack_u16(20.0)],
                    ),
                    DayFrame(
                        date=20260829,
                        slots=[0, 1],
                        xs=[pack_u16(44.25), pack_u16(88.5)],
                        ys=[pack_u16(120.0), pack_u16(200.0)],
                    ),
                ],
            )
            write_month(v1 / "2026-08.bin", month)
            packed = last_packed_xy(timeline)
            self.assertEqual(set(packed), {58000, 58001})
            self.assertAlmostEqual(packed[58000][0], unpack_u16(pack_u16(44.25)), places=9)
            self.assertAlmostEqual(packed[58000][1], unpack_u16(pack_u16(120.0)), places=9)
            self.assertAlmostEqual(packed[58001][0], unpack_u16(pack_u16(88.5)), places=9)

    def test_dump_overlays_packed_last_frame_over_lock_state(self):
        sat = _sat(58000, 15.301912, 53.16)
        noon = datetime(2026, 8, 30, 12, 0, 0)
        clock = Clock(sat.mean_motion, sat.inclination, sat.ecc, None, "own")
        computed_x, computed_y = locked_xy(sat, clock, noon)
        packed_x, packed_y = 12.3456, 78.9012
        self.assertGreater(min(abs(computed_x - packed_x), 360.0 - abs(computed_x - packed_x)), 1.0)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            timeline = root / "timeline"
            v1 = timeline / "v1"
            v1.mkdir(parents=True)
            ShellRefs().save(timeline / "shell_refs.json")
            state = LockState()
            apply_locks([sat], {sat.norad_id: clock}, noon, state, "2026-08-30")
            state.sats[sat.norad_id].x = 111.1111
            state.sats[sat.norad_id].y = 222.2222
            state.save(timeline / "lock_state.json")
            catalog = TimelineCatalog(
                start="2026-08-29",
                end="2026-08-29",
                sats=[CatalogSat(id=58000, name=sat.name, inc=53)],
            )
            catalog.save(timeline / "catalog.json")
            write_month(
                v1 / "2026-08.bin",
                MonthBin(
                    year=2026,
                    month=8,
                    catalog_len=1,
                    first_date=20260829,
                    days=[
                        DayFrame(
                            date=20260829,
                            slots=[0],
                            xs=[pack_u16(packed_x)],
                            ys=[pack_u16(packed_y)],
                        )
                    ],
                ),
            )
            payload = dump_sats(
                root / "sats.json",
                timeline_dir=timeline,
                frame_date=date(2026, 8, 30),
                sats=[sat],
            )
            rec = payload["sats"][0]
            want_x = unpack_u16(pack_u16(packed_x))
            want_y = unpack_u16(pack_u16(packed_y))
            self.assertAlmostEqual(rec["x"], round(want_x, 4), places=4)
            self.assertAlmostEqual(rec["y"], round(want_y, 4), places=4)
            self.assertNotAlmostEqual(rec["x"], 111.1111, places=2)
            self.assertNotAlmostEqual(rec["x"], round(computed_x, 4), places=2)

    def test_overlay_skips_norads_not_in_dump(self):
        xy = {1: (1.0, 2.0)}
        n = overlay_packed_xy(xy, {1: (9.0, 8.0), 2: (7.0, 6.0)}, {1})
        self.assertEqual(n, 1)
        self.assertEqual(xy[1], (9.0, 8.0))
        self.assertNotIn(2, xy)


if __name__ == "__main__":
    unittest.main()
