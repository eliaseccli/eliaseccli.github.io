"""Slim GP dump keeps SGP4 fields and ISS (ZARYA)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from refresh.dump_gp import dump_gp, pick_iss, slim_record


STARLINK = {
    "OBJECT_NAME": "STARLINK-1008",
    "NORAD_CAT_ID": 44714,
    "EPOCH": "2026-09-01T11:22:43.942944",
    "MEAN_MOTION": 15.62915731,
    "ECCENTRICITY": 0.00037061,
    "INCLINATION": 53.1488,
    "RA_OF_ASC_NODE": 60.05,
    "ARG_OF_PERICENTER": 90.9958,
    "MEAN_ANOMALY": 269.1481,
    "BSTAR": 1.2e-4,
    "MEAN_MOTION_DOT": 3.1e-5,
}

ZARYA = {
    "OBJECT_NAME": "ISS (ZARYA)",
    "NORAD_CAT_ID": 25544,
    "EPOCH": "2026-09-01T10:00:00.000000",
    "MEAN_MOTION": 15.494,
    "ECCENTRICITY": 0.0004,
    "INCLINATION": 51.64,
    "RA_OF_ASC_NODE": 10.0,
    "ARG_OF_PERICENTER": 20.0,
    "MEAN_ANOMALY": 30.0,
    "BSTAR": 0.0,
    "MEAN_MOTION_DOT": 0.0,
}

NAUKA = {
    "OBJECT_NAME": "ISS (NAUKA)",
    "NORAD_CAT_ID": 49044,
    "EPOCH": "2026-09-01T10:00:00.000000",
    "MEAN_MOTION": 15.494,
    "ECCENTRICITY": 0.0004,
    "INCLINATION": 51.64,
    "RA_OF_ASC_NODE": 10.0,
    "ARG_OF_PERICENTER": 20.0,
    "MEAN_ANOMALY": 30.0,
    "BSTAR": 0.0,
    "MEAN_MOTION_DOT": 0.0,
}


class TestDumpGp(unittest.TestCase):
    def test_slim_record_kind(self):
        row = slim_record(STARLINK, "sl")
        self.assertEqual(row[0], "STARLINK-1008")
        self.assertEqual(row[1], 44714)
        self.assertEqual(row[2], "2026-09-01T11:22:43.942944")
        self.assertEqual(row[5], 53.1488)
        self.assertEqual(row[-1], "sl")

    def test_pick_iss_prefers_zarya(self):
        hit = pick_iss([NAUKA, ZARYA])
        self.assertEqual(hit["NORAD_CAT_ID"], 25544)
        self.assertIn("ZARYA", hit["OBJECT_NAME"])

    def test_dump_gp_offline(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            sl = root / "starlink.json"
            st = root / "stations.json"
            sl.write_text(json.dumps([STARLINK]), encoding="utf-8")
            st.write_text(json.dumps([NAUKA, ZARYA]), encoding="utf-8")
            out = root / "gp.json"
            payload = dump_gp(
                out,
                starlink_path=sl,
                stations_path=st,
                fetch_missing=False,
            )
            self.assertEqual(payload["n"], 2)
            self.assertTrue(out.exists())
            body = json.loads(out.read_text(encoding="utf-8"))
            kinds = {row[-1] for row in body["sats"]}
            ids = {row[1] for row in body["sats"]}
            self.assertEqual(kinds, {"sl", "iss"})
            self.assertEqual(ids, {44714, 25544})
            self.assertNotIn("x", json.dumps(body["sats"][0]))
            self.assertNotIn("MEAN_MOTION", json.dumps(body))

    def test_dump_gp_requires_records(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            empty = root / "empty.json"
            empty.write_text("[]", encoding="utf-8")
            with self.assertRaises(SystemExit):
                dump_gp(
                    root / "gp.json",
                    starlink_path=empty,
                    stations_path=empty,
                    fetch_missing=False,
                )


if __name__ == "__main__":
    unittest.main()
