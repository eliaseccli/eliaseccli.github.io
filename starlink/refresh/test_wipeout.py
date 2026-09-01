"""50% wipeout detector and packed-position interpolation."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

from refresh.binary import DayFrame, MonthBin, decode_month, write_month
from refresh.catalog import CatalogSat, TimelineCatalog
from refresh.j2 import pack_u16, unpack_u16
from refresh.wipeout import (
    FLAG_SYNTHETIC,
    apply_hole_fill,
    fill_v1_holes,
    interpolate_frame,
    is_synthetic,
    lerp_angle,
    neighbor_median,
    today_is_wipeout,
    wipeout_mask,
)


class TestWipeoutDetect(unittest.TestCase):
    def test_neighbor_median_excludes_self_and_does_not_wrap(self):
        counts = [10, 10, 10, 1, 10, 10, 10]
        self.assertEqual(neighbor_median(counts, 3), 10.0)
        # Circular wrap would use the 1 at the other end; we must not.
        tail = [1, 10, 10, 10, 10, 10, 10]
        self.assertEqual(neighbor_median(tail, 0), 10.0)
        self.assertFalse(wipeout_mask(tail)[6])

    def test_fifty_percent_rule_matches_irregular_scan(self):
        # 7-day window, self excluded. 50% below → wipeout; 49% is not.
        counts = [100, 100, 100, 50, 100, 100, 100]
        self.assertEqual(wipeout_mask(counts), [False, False, False, True, False, False, False])
        counts[3] = 51
        self.assertFalse(wipeout_mask(counts)[3])

    def test_ten_percent_count_on_flat_series(self):
        counts = [100] * 7
        counts[3] = 89
        ten = wipeout_mask(counts, drop_frac=0.10)
        self.assertTrue(ten[3])
        self.assertFalse(wipeout_mask(counts, drop_frac=0.50)[3])


class TestInterpolate(unittest.TestCase):
    def test_shortest_arc_and_intersection_only(self):
        before = DayFrame(
            date=20200320,
            slots=[0, 1, 2],
            xs=[pack_u16(350.0), pack_u16(10.0), pack_u16(40.0)],
            ys=[pack_u16(10.0), pack_u16(20.0), pack_u16(30.0)],
        )
        after = DayFrame(
            date=20200322,
            slots=[1, 2, 3],
            xs=[pack_u16(30.0), pack_u16(80.0), pack_u16(1.0)],
            ys=[pack_u16(40.0), pack_u16(90.0), pack_u16(1.0)],
        )
        mid = interpolate_frame(before, after, 20200321)
        self.assertEqual(mid.flags, FLAG_SYNTHETIC)
        self.assertEqual(mid.slots, [1, 2])
        self.assertAlmostEqual(unpack_u16(mid.xs[0]), 20.0, places=2)
        # 350 → 30 shortest-arc is +40, halfway = 10 for slot 1? slot 1 is 10→30.
        # slot 2: 40→80 halfway 60
        self.assertAlmostEqual(unpack_u16(mid.ys[0]), 30.0, places=2)
        self.assertAlmostEqual(unpack_u16(mid.xs[1]), 60.0, places=2)

    def test_lerp_angle_wraps_shortest_arc(self):
        self.assertAlmostEqual(lerp_angle(350.0, 10.0, 0.5), 0.0, places=9)
        self.assertAlmostEqual(lerp_angle(10.0, 350.0, 0.5), 0.0, places=9)


class TestFillBins(unittest.TestCase):
    def test_fill_replaces_wipeout_and_keeps_end_on_last_real(self):
        with tempfile.TemporaryDirectory() as td:
            timeline = Path(td)
            v1 = timeline / "v1"
            v1.mkdir()
            start = date(2020, 3, 18)
            days = []
            for i in range(7):
                d = start + timedelta(days=i)
                n = 16 if d == date(2020, 3, 21) else 100
                days.append(
                    DayFrame(
                        date=d.year * 10000 + d.month * 100 + d.day,
                        slots=list(range(n)),
                        xs=[pack_u16(float(s)) for s in range(n)],
                        ys=[pack_u16(float(s + 1)) for s in range(n)],
                    )
                )
            write_month(
                v1 / "2020-03.bin",
                MonthBin(year=2020, month=3, catalog_len=100, first_date=20200318, days=days),
            )
            catalog = TimelineCatalog(
                start="2020-03-18",
                end="2020-03-24",
                sats=[CatalogSat(id=1000 + i, name=f"S{i}", inc=53) for i in range(100)],
            )
            catalog.save(timeline / "catalog.json")
            info = apply_hole_fill(timeline)
            self.assertEqual(info["last_real"], "2020-03-24")
            self.assertEqual(info["synthetic"], ["2020-03-21"])
            month = decode_month((v1 / "2020-03.bin").read_bytes())
            hole = next(d for d in month.days if d.date == 20200321)
            self.assertTrue(is_synthetic(hole.flags))
            self.assertEqual(len(hole.slots), 100)
            self.assertEqual(hole.slots, list(range(100)))
            man = json.loads((timeline / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(man["end"], "2020-03-24")
            self.assertEqual(man["synthetic"], ["2020-03-21"])
            cat = TimelineCatalog.load(timeline / "catalog.json")
            self.assertEqual(cat.end, "2020-03-24")

    def test_trailing_wipeout_does_not_become_end(self):
        with tempfile.TemporaryDirectory() as td:
            timeline = Path(td)
            v1 = timeline / "v1"
            v1.mkdir()
            days = []
            for i, n in enumerate([80, 80, 80, 80, 80, 80, 2]):
                d = date(2026, 6, 15) + timedelta(days=i)
                days.append(
                    DayFrame(
                        date=d.year * 10000 + d.month * 100 + d.day,
                        slots=list(range(n)),
                        xs=[pack_u16(1.0)] * n,
                        ys=[pack_u16(2.0)] * n,
                    )
                )
            write_month(
                v1 / "2026-06.bin",
                MonthBin(year=2026, month=6, catalog_len=80, first_date=20260615, days=days),
            )
            catalog = TimelineCatalog(
                start="2026-06-15",
                end="2026-06-21",
                sats=[CatalogSat(id=i, name=f"S{i}", inc=53) for i in range(80)],
            )
            catalog.save(timeline / "catalog.json")
            info = apply_hole_fill(timeline)
            self.assertEqual(info["last_real"], "2026-06-20")
            self.assertIn("2026-06-21", info["synthetic"])
            cat = TimelineCatalog.load(timeline / "catalog.json")
            self.assertEqual(cat.end, "2026-06-20")

    def test_today_is_wipeout_uses_neighbor_median(self):
        with tempfile.TemporaryDirectory() as td:
            v1 = Path(td) / "v1"
            v1.mkdir()
            days = []
            for i in range(6):
                d = date(2026, 8, 26) + timedelta(days=i)
                days.append(
                    DayFrame(
                        date=d.year * 10000 + d.month * 100 + d.day,
                        slots=list(range(100)),
                        xs=[0] * 100,
                        ys=[0] * 100,
                    )
                )
            write_month(
                v1 / "2026-08.bin",
                MonthBin(year=2026, month=8, catalog_len=100, first_date=20260826, days=days),
            )
            self.assertTrue(today_is_wipeout(v1, date(2026, 9, 1), 10))
            self.assertFalse(today_is_wipeout(v1, date(2026, 9, 1), 90))


if __name__ == "__main__":
    unittest.main()
