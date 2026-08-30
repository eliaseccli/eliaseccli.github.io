"""STLK v1 encode/decode, including the committed 2019-05 month header."""

from __future__ import annotations

import unittest
from pathlib import Path

from refresh.binary import DayFrame, MonthBin, decode_month, encode_month, upsert_day, ymd_int
from refresh.j2 import pack_u16

REPO = Path(__file__).resolve().parents[2]
MAY2019 = REPO / "starlink" / "timeline" / "v1" / "2019-05.bin"


class TestBinary(unittest.TestCase):
    def test_roundtrip_tiny_month(self):
        month = MonthBin(
            year=2019,
            month=5,
            catalog_len=3,
            first_date=20190524,
            days=[
                DayFrame(date=20190524, slots=[0], xs=[pack_u16(40)], ys=[pack_u16(80)]),
                DayFrame(date=20190525, slots=[0, 2], xs=[pack_u16(1), pack_u16(2)], ys=[pack_u16(3), pack_u16(4)]),
            ],
        )
        raw = encode_month(month)
        back = decode_month(raw)
        self.assertEqual(back.year, 2019)
        self.assertEqual(back.month, 5)
        self.assertEqual(len(back.days), 2)
        self.assertEqual(back.catalog_len, 3)
        self.assertEqual(back.first_date, 20190524)
        self.assertEqual(back.days[0].slots, [0])
        self.assertEqual(back.days[0].xs[0], pack_u16(40))
        self.assertEqual(back.days[1].slots, [0, 2])
        again = decode_month(encode_month(back))
        self.assertEqual(encode_month(again), raw)

    def test_upsert_expands_catalog_len(self):
        month = MonthBin(year=2026, month=8, catalog_len=3, first_date=20260801, days=[])
        upsert_day(month, DayFrame(date=20260801, slots=[0], xs=[1], ys=[2]), 3)
        upsert_day(month, DayFrame(date=20260802, slots=[3], xs=[5], ys=[6]), 4)
        self.assertEqual(month.catalog_len, 4)
        self.assertEqual([d.date for d in month.days], [20260801, 20260802])
        raw = encode_month(month)
        back = decode_month(raw)
        self.assertEqual(back.catalog_len, 4)
        self.assertEqual(back.days[0].slots, [0])
        self.assertEqual(back.days[1].slots, [3])

    def test_committed_2019_05_header(self):
        if not MAY2019.exists():
            self.skipTest("2019-05.bin not present")
        month = decode_month(MAY2019.read_bytes())
        self.assertEqual(month.year, 2019)
        self.assertEqual(month.month, 5)
        self.assertEqual(len(month.days), 8)
        self.assertEqual(month.first_date, 20190524)
        self.assertGreaterEqual(month.catalog_len, 3)
        self.assertEqual(month.days[0].date, ymd_int(2019, 5, 24))
        self.assertEqual(month.days[-1].date, ymd_int(2019, 5, 31))


if __name__ == "__main__":
    unittest.main()
