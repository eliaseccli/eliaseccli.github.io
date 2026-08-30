"""Alpha-5 NORAD decode and 2LE/3LE TLE parsing."""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from refresh.parse import iter_tle_file, parse_norad_id, parse_tle_file


class TestAlpha5(unittest.TestCase):
    def test_numeric(self):
        self.assertEqual(parse_norad_id("44235"), 44235)
        self.assertEqual(parse_norad_id(" 123 "), 123)

    def test_alpha5_skip_i_and_o(self):
        self.assertEqual(parse_norad_id("A0459"), 100459)
        self.assertEqual(parse_norad_id("A0000"), 100000)
        self.assertEqual(parse_norad_id("H0000"), 170000)
        self.assertEqual(parse_norad_id("J0000"), 180000)
        self.assertEqual(parse_norad_id("Z9999"), 339999)
        with self.assertRaises(ValueError):
            parse_norad_id("I0000")
        with self.assertRaises(ValueError):
            parse_norad_id("O0000")


class TestTleFile(unittest.TestCase):
    def test_2le_and_3le_and_alpha5(self):
        text = "\n".join(
            [
                "STARLINK-31",
                "1 44235U 19029A   19144.50000000  .00000000  00000-0  00000-0 0  9990",
                "2 44235  53.1604  80.0000 0001000  40.0000  20.0000 15.30191200000000",
                "1 A0459U 24320A   25180.50000000  .00000000  00000-0  00000-0 0  9998",
                "2 A0459  70.0000  10.0000 0002000  30.0000  40.0000 15.06400000000000",
                "",
            ]
        )
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "starlink_2019.tle"
            path.write_text(text, encoding="utf-8")
            sats = parse_tle_file(path)
            ids = [s.norad_id for s in iter_tle_file(path)]
        self.assertEqual(len(sats), 2)
        self.assertEqual(sats[0].norad_id, 44235)
        self.assertEqual(sats[0].name, "STARLINK-31")
        self.assertEqual(sats[0].epoch, datetime(2019, 5, 24, 12, 0, 0))
        self.assertAlmostEqual(sats[0].inclination, 53.1604)
        self.assertAlmostEqual(sats[0].mean_motion, 15.301912)
        self.assertEqual(sats[1].norad_id, 100459)
        self.assertTrue(sats[1].name.startswith("STARLINK-"))
        self.assertEqual(ids, [44235, 100459])


if __name__ == "__main__":
    unittest.main()
