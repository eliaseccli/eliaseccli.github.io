"""Historical packer and daily append on synthetic TLE / GP JSON."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from refresh.append_day import append_today
from refresh.binary import decode_month
from refresh.catalog import TimelineCatalog
from refresh.clocks import ShellRefs
from refresh.j2 import T0, j2_rates, lock_xy, unpack_u16
from refresh.orbit import deg_per_sec
from refresh.pack_timeline import pack_timeline

N_SK = 15.301912
I_SK = 53.1604


def _epoch_fields(dt: datetime) -> tuple[int, float]:
    yy = dt.year % 100
    doy = (dt - datetime(dt.year, 1, 1)).total_seconds() / 86400.0 + 1.0
    return yy, doy


def _tle_pair(
    norad: int,
    name: str,
    epoch: datetime,
    inc: float,
    raan: float,
    ecc: float,
    argp: float,
    m: float,
    n: float,
) -> str:
    yy, doy = _epoch_fields(epoch)
    num = f"{norad:05d}" if norad < 100000 else "A" + f"{norad - 100000:04d}"
    line1 = (
        f"1 {num}U 19029A   {yy:02d}{doy:012.8f}  .00000000  00000-0  00000-0 0  9990"
    )
    ecc_s = f"{ecc:.7f}".split(".")[1][:7]
    line2 = (
        f"2 {num} {inc:8.4f} {raan:8.4f} {ecc_s} {argp:8.4f} {m:8.4f} {n:11.8f}00000"
    )
    return f"{name}\n{line1}\n{line2}\n"


class TestPackAndAppend(unittest.TestCase):
    def test_pack_synthetic_sk_month(self):
        omega_dot, argp_dot = j2_rates(N_SK, I_SK, 0.0)
        raan0, argp0, m0 = 15.0, 25.0, 35.0
        lines = []
        start = datetime(2019, 5, 24, 12, 0, 0)
        self.assertEqual(start, T0)
        for day in range(8):
            t = start + timedelta(days=day)
            dt = (t - T0).total_seconds()
            raan = (raan0 + omega_dot * dt) % 360.0
            argp = (argp0 + argp_dot * dt) % 360.0
            mean_anom = (m0 + deg_per_sec(N_SK) * dt) % 360.0
            lines.append(
                _tle_pair(44235, "STARLINK-31", t, I_SK, raan, 0.0001, argp, mean_anom, N_SK)
            )
        with tempfile.TemporaryDirectory() as td:
            tle_dir = Path(td) / "tles"
            out = Path(td) / "out"
            tle_dir.mkdir()
            (tle_dir / "starlink_2019.tle").write_text("".join(lines), encoding="utf-8")
            info = pack_timeline(tle_dir, out)
            self.assertEqual(info["days"], 8)
            self.assertEqual(info["catalog"], 1)
            cat = TimelineCatalog.load(out / "catalog.json")
            self.assertEqual(cat.fps, 15)
            self.assertEqual(cat.sats[0].id, 44235)
            status = (out / "STATUS.txt").read_text(encoding="utf-8")
            self.assertIn("2019:", status)
            raw = (out / "v1" / "2019-05.bin").read_bytes()
            month = decode_month(raw)
            self.assertEqual(month.catalog_len, 1)
            self.assertEqual(len(month.days), 8)
            xs = [unpack_u16(d.xs[0]) for d in month.days]
            ys = [unpack_u16(d.ys[0]) for d in month.days]
            # 8 sats < detect_peaks min_count → clump clock; synthetic SK still locks.
            self.assertLess(max(xs) - min(xs), 0.02)
            self.assertLess(max(ys) - min(ys), 0.02)
            want_x, want_y = lock_xy(
                argp=argp0,
                mean_anomaly=m0,
                mean_motion=N_SK,
                raan=raan0,
                epoch=start,
                t=start,
                n_shell=N_SK,
                omega_dot_deg_s=argp_dot,
                Omega_dot_deg_s=omega_dot,
            )
            self.assertAlmostEqual(xs[0], want_x, delta=0.02)
            self.assertAlmostEqual(ys[0], want_y, delta=0.02)

    def test_append_day_from_gp(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            timeline = root / "timeline"
            v1 = timeline / "v1"
            v1.mkdir(parents=True)
            cat = TimelineCatalog(end="2026-08-29")
            cat.sats = []
            # Seed catalog via packer-like append through TimelineCatalog
            from refresh.parse import Sat
            from refresh.orbit import altitude_km

            seed = Sat(
                name="STARLINK-31",
                norad_id=44235,
                epoch=datetime(2026, 8, 29, 11, 0, 0),
                inclination=53.16,
                raan=10.0,
                argp=20.0,
                mean_anomaly=30.0,
                ecc=0.0001,
                mean_motion=N_SK,
                altitude_km=altitude_km(N_SK, 0.0001),
            )
            cat.append_sat(seed)
            cat.save(timeline / "catalog.json")
            ShellRefs().save(timeline / "shell_refs.json")
            gp = [
                {
                    "OBJECT_NAME": "STARLINK-31",
                    "NORAD_CAT_ID": 44235,
                    "EPOCH": "2026-08-30T11:00:00",
                    "INCLINATION": 53.16,
                    "RA_OF_ASC_NODE": 10.0,
                    "ARG_OF_PERICENTER": 20.0,
                    "MEAN_ANOMALY": 30.0,
                    "ECCENTRICITY": 0.0001,
                    "MEAN_MOTION": N_SK,
                },
                {
                    "OBJECT_NAME": "STARLINK-NEW",
                    "NORAD_CAT_ID": 99999,
                    "EPOCH": "2026-08-30T11:30:00",
                    "INCLINATION": 53.10,
                    "RA_OF_ASC_NODE": 11.0,
                    "ARG_OF_PERICENTER": 21.0,
                    "MEAN_ANOMALY": 31.0,
                    "ECCENTRICITY": 0.0002,
                    "MEAN_MOTION": 15.40,
                },
            ]
            gp_path = root / "starlink_gp.json"
            gp_path.write_text(json.dumps(gp), encoding="utf-8")
            from datetime import date

            info = append_today(timeline, gp_path=gp_path, frame_date=date(2026, 8, 30))
            self.assertEqual(info["n"], 2)
            self.assertEqual(info["catalog"], 2)
            cat2 = TimelineCatalog.load(timeline / "catalog.json")
            self.assertEqual(cat2.sats[0].id, 44235)
            self.assertEqual(cat2.sats[1].id, 99999)
            self.assertEqual(cat2.end, "2026-08-30")
            month = decode_month((v1 / "2026-08.bin").read_bytes())
            self.assertEqual(month.catalog_len, 2)
            self.assertEqual(month.days[0].date, 20260830)
            self.assertEqual(month.days[0].slots, [0, 1])

    def test_append_day_persists_pending_across_action_runs(self):
        """Daily Action loads/saves shell_refs.json; a new shell freezes over a week."""
        from datetime import date

        from refresh.clocks import STABLE_DAYS
        from refresh.parse import Sat
        from refresh.orbit import altitude_km

        n = N_SK
        inc = 53.16
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            timeline = root / "timeline"
            (timeline / "v1").mkdir(parents=True)
            cat = TimelineCatalog(end="2025-06-28")
            cat.sats = []
            seed = Sat(
                name="STARLINK-31",
                norad_id=58000,
                epoch=datetime(2025, 6, 28, 12, 0, 0),
                inclination=inc,
                raan=10.0,
                argp=20.0,
                mean_anomaly=30.0,
                ecc=0.0001,
                mean_motion=n,
                altitude_km=altitude_km(n, 0.0001),
            )
            cat.append_sat(seed)
            cat.save(timeline / "catalog.json")
            ShellRefs().save(timeline / "shell_refs.json")

            def gp_records(epoch: str) -> list[dict]:
                return [
                    {
                        "OBJECT_NAME": f"STARLINK-{58000 + i}",
                        "NORAD_CAT_ID": 58000 + i,
                        "EPOCH": epoch,
                        "INCLINATION": inc,
                        "RA_OF_ASC_NODE": 10.0,
                        "ARG_OF_PERICENTER": 20.0,
                        "MEAN_ANOMALY": 30.0,
                        "ECCENTRICITY": 0.0001,
                        "MEAN_MOTION": n,
                    }
                    for i in range(40)
                ]

            gp_path = root / "starlink_gp.json"
            start = date(2025, 6, 29)
            for i in range(STABLE_DAYS - 1):
                d = start + timedelta(days=i)
                gp_path.write_text(
                    json.dumps(gp_records(d.isoformat() + "T12:00:00")),
                    encoding="utf-8",
                )
                info = append_today(timeline, gp_path=gp_path, frame_date=d)
                self.assertEqual(info["piles"], 0)
                self.assertEqual(info["pending"], 1)
                refs = ShellRefs.load(timeline / "shell_refs.json")
                self.assertEqual(refs.piles, [])
                self.assertEqual(len(refs.pending), 1)
                self.assertEqual(refs.pending[0].streak, i + 1)
                self.assertEqual(refs.pending[0].last, d.isoformat())

            d5 = start + timedelta(days=STABLE_DAYS - 1)
            gp_path.write_text(
                json.dumps(gp_records(d5.isoformat() + "T12:00:00")),
                encoding="utf-8",
            )
            info = append_today(timeline, gp_path=gp_path, frame_date=d5)
            self.assertEqual(info["piles"], 1)
            self.assertEqual(info["pending"], 0)
            refs = ShellRefs.load(timeline / "shell_refs.json")
            self.assertEqual(len(refs.piles), 1)
            self.assertEqual(refs.pending, [])
            self.assertAlmostEqual(refs.piles[0].n, n, places=6)


if __name__ == "__main__":
    unittest.main()
