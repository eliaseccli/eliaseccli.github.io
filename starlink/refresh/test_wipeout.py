"""20% wipeout detector, packed lerp, and 10-day shortest-arc mean."""

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
    circular_mean,
    date_to_ymd,
    upsert_raw_tail,
    fill_v1_holes,
    hold_one_day_dropouts,
    interpolate_frame,
    is_synthetic,
    lerp_angle,
    neighbor_median,
    smooth_nday,
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

    def test_twenty_percent_rule(self):
        # 7-day window, self excluded. 20% below → wipeout; just under is not.
        counts = [100, 100, 100, 80, 100, 100, 100]
        self.assertEqual(wipeout_mask(counts), [False, False, False, True, False, False, False])
        counts[3] = 81
        self.assertFalse(wipeout_mask(counts)[3])
        counts[3] = 50
        self.assertTrue(wipeout_mask(counts)[3])

    def test_ten_percent_count_on_flat_series(self):
        counts = [100] * 7
        counts[3] = 89
        ten = wipeout_mask(counts, drop_frac=0.10)
        self.assertTrue(ten[3])
        self.assertFalse(wipeout_mask(counts, drop_frac=0.20)[3])
        self.assertFalse(wipeout_mask(counts, drop_frac=0.50)[3])

    def test_none_counts_are_holes_and_skipped_as_neighbors(self):
        counts: list[int | None] = [100, None, 100, 70, 100, 100, 100]
        mask = wipeout_mask(counts)
        self.assertTrue(mask[1])
        self.assertTrue(mask[3])
        self.assertFalse(mask[0])


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

    def test_circular_mean_wraps_359_1(self):
        self.assertAlmostEqual(circular_mean([359.0, 0.0, 1.0]), 0.0, places=9)
        self.assertAlmostEqual(circular_mean([1.0, 359.0, 0.0]), 0.0, places=9)
        self.assertAlmostEqual(circular_mean([350.0, 10.0]), 0.0, places=9)


class TestMembershipHold(unittest.TestCase):
    def test_one_day_dropout_is_held_not_invented(self):
        days = [
            DayFrame(date=20200320, slots=[0, 1, 2], xs=[pack_u16(10), pack_u16(20), pack_u16(30)], ys=[pack_u16(1), pack_u16(2), pack_u16(3)]),
            DayFrame(date=20200321, slots=[0, 2], xs=[pack_u16(12), pack_u16(32)], ys=[pack_u16(1), pack_u16(3)]),
            DayFrame(date=20200322, slots=[0, 1, 2, 3], xs=[pack_u16(14), pack_u16(24), pack_u16(34), pack_u16(99)], ys=[pack_u16(1), pack_u16(2), pack_u16(3), pack_u16(9)]),
        ]
        held = hold_one_day_dropouts(days)
        self.assertEqual(held[1].slots, [0, 1, 2])
        self.assertNotIn(3, held[1].slots)
        self.assertAlmostEqual(unpack_u16(held[1].xs[1]), 22.0, places=2)
        self.assertEqual(held[0].slots, [0, 1, 2])
        self.assertEqual(held[2].slots, [0, 1, 2, 3])


def _deg_days(xs: list[float], ys: list[float] | None = None) -> list[DayFrame]:
    days = []
    for i, x in enumerate(xs):
        y = 0.0 if ys is None else ys[i]
        days.append(
            DayFrame(
                date=date_to_ymd(date(2020, 3, 20) + timedelta(days=i)),
                slots=[0],
                xs=[pack_u16(x)],
                ys=[pack_u16(y)],
            )
        )
    return days


class TestSmoothTriangular(unittest.TestCase):
    def test_linear_drift_is_kept_in_the_middle(self):
        # Symmetric triangular weights: a straight line is unchanged mid-series.
        xs = [10.0 + i for i in range(30)]
        out = smooth_nday(_deg_days(xs))
        for i in range(9, 21):
            self.assertAlmostEqual(unpack_u16(out[i].xs[0]), xs[i], places=2)

    def test_edges_are_smoothed_one_sided(self):
        # Noise on the newest day is damped, not left raw.
        xs = [10.0] * 20 + [14.0]
        out = smooth_nday(_deg_days(xs))
        got = unpack_u16(out[-1].xs[0])
        self.assertLess(got, 11.0)
        self.assertGreater(got, 10.0)

    def test_jitter_is_damped(self):
        xs = [10.0 + (1.0 if i % 2 else -1.0) for i in range(40)]
        out = smooth_nday(_deg_days(xs))
        for i in range(9, 31):
            self.assertLess(abs(unpack_u16(out[i].xs[0]) - 10.0), 0.15)

    def test_wrap_359_1(self):
        xs = [359.0, 0.0, 1.0] * 8
        out = smooth_nday(_deg_days(xs))
        for f in out:
            v = unpack_u16(f.xs[0])
            self.assertLess(min(v, 360.0 - v), 1.01)

    def test_gap_and_missing_slot_still_smooth(self):
        # Day 5 missing entirely; slot 1 missing on days 3 and 7.
        days = []
        for i in range(20):
            if i == 5:
                continue
            slots = [0, 1] if i not in (3, 7) else [0]
            x = 10.0 + (2.0 if i == 10 else 0.0)
            days.append(
                DayFrame(
                    date=date_to_ymd(date(2020, 3, 1) + timedelta(days=i)),
                    slots=slots,
                    xs=[pack_u16(x)] * len(slots),
                    ys=[pack_u16(0.0)] * len(slots),
                )
            )
        out = smooth_nday(days)
        spike = next(f for f in out if f.date == 20200311)
        self.assertEqual(spike.slots, [0, 1])
        for v in spike.xs:
            self.assertLess(unpack_u16(v), 10.5)

    def test_only_from_leaves_history(self):
        days = _deg_days([10.0 + (i % 2) for i in range(20)])
        out = smooth_nday(days, only_from=days[10].date)
        for i in range(10):
            self.assertIs(out[i], days[i])
        self.assertNotEqual(out[15].xs, days[15].xs)


class TestDailyTail(unittest.TestCase):
    def test_daily_append_matches_full_smooth(self):
        import random

        rnd = random.Random(1)
        raw = []
        for i in range(40):
            d = date(2026, 9, 1) + timedelta(days=i)
            raw.append(
                DayFrame(
                    date=date_to_ymd(d),
                    slots=[0, 1, 2],
                    xs=[pack_u16((350.0 + 0.3 * i + rnd.uniform(-2, 2)) % 360) for _ in range(3)],
                    ys=[pack_u16(5.0 + rnd.uniform(-2, 2)) for _ in range(3)],
                )
            )

        def write(v1, frames):
            by = {}
            for f in frames:
                by.setdefault(f.date // 100, []).append(f)
            for ym, days in by.items():
                write_month(
                    v1 / f"{ym // 100:04d}-{ym % 100:02d}.bin",
                    MonthBin(year=ym // 100, month=ym % 100, catalog_len=3, first_date=days[0].date, days=days),
                )

        def read_all(v1):
            out = []
            for p in sorted(v1.glob("????-??.bin")):
                out.extend(decode_month(p.read_bytes()).days)
            return out

        with tempfile.TemporaryDirectory() as td:
            full = Path(td) / "full" / "v1"
            full.mkdir(parents=True)
            write(full, raw)
            fill_v1_holes(full, smooth="all")
            inc = Path(td) / "inc" / "v1"
            inc.mkdir(parents=True)
            write(inc, raw[:25])
            fill_v1_holes(inc, smooth="all")
            for f in raw[25:]:
                ym = f.date // 100
                path = inc / f"{ym // 100:04d}-{ym % 100:02d}.bin"
                month = decode_month(path.read_bytes()) if path.exists() else MonthBin(
                    year=ym // 100, month=ym % 100, catalog_len=3, first_date=f.date, days=[]
                )
                month.days = [d for d in month.days if d.date != f.date] + [f]
                month.days.sort(key=lambda d: d.date)
                write_month(path, month)
                upsert_raw_tail(inc, f)
                fill_v1_holes(inc)
            self.assertEqual(read_all(inc), read_all(full))


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

    def test_twenty_percent_day_is_filled(self):
        with tempfile.TemporaryDirectory() as td:
            timeline = Path(td)
            v1 = timeline / "v1"
            v1.mkdir()
            start = date(2020, 3, 18)
            days = []
            for i in range(7):
                d = start + timedelta(days=i)
                n = 75 if d == date(2020, 3, 21) else 100
                days.append(
                    DayFrame(
                        date=d.year * 10000 + d.month * 100 + d.day,
                        slots=list(range(n)),
                        xs=[pack_u16(10.0 + i)] * n,
                        ys=[pack_u16(20.0 + i)] * n,
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
            self.assertEqual(info["synthetic"], ["2020-03-21"])
            month = decode_month((v1 / "2020-03.bin").read_bytes())
            hole = next(d for d in month.days if d.date == 20200321)
            self.assertTrue(is_synthetic(hole.flags))
            self.assertEqual(len(hole.slots), 100)

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
            self.assertTrue(today_is_wipeout(v1, date(2026, 9, 1), 80))
            self.assertFalse(today_is_wipeout(v1, date(2026, 9, 1), 81))
            self.assertFalse(today_is_wipeout(v1, date(2026, 9, 1), 90))


if __name__ == "__main__":
    unittest.main()
