"""J2 rates (STARLINK-30514-like) and x/y pile-lock on a synthetic SK sat."""

from __future__ import annotations

import math
import unittest
from datetime import datetime, timedelta

from refresh.j2 import J2, MU, R, T0, j2_rates, lock_xy, pack_u16, unpack_u16
from refresh.orbit import G, M, deg_per_sec

# STARLINK-30514 / NORAD 58028, 53° ~475 km (user-verified vs TLE dRAAN).
N_SK = 15.301912
I_SK = 53.1604
E_SK = 0.0
# Independent evaluation of the specified formula (deg/s).
OMEGA_DOT_SK = -5.376713565559e-05


class TestJ2Rates(unittest.TestCase):
    def test_earth_constants_match_orbit(self):
        self.assertEqual(MU, G * M)
        self.assertEqual(R, 6378135)
        self.assertEqual(J2, 1.08262668e-3)

    def test_omega_dot_30514_like(self):
        omega_dot, _argp_dot = j2_rates(N_SK, I_SK, E_SK)
        self.assertLess(abs(omega_dot - OMEGA_DOT_SK), 1e-7)
        # ~-4.645 deg/day; vs TLE dRAAN the residual was 0.0006 deg/day.
        self.assertAlmostEqual(omega_dot * 86400.0, -4.645480520643, places=6)

    def test_formula_matches_spec(self):
        n = N_SK * 2.0 * math.pi / 86400.0
        a = (MU / n**2) ** (1.0 / 3.0)
        i = math.radians(I_SK)
        fac = J2 * (R / a) ** 2 / (1.0 - E_SK * E_SK) ** 2
        want_o = math.degrees(-1.5 * n * fac * math.cos(i))
        want_w = math.degrees(0.75 * n * fac * (4.0 - 5.0 * math.sin(i) ** 2))
        got_o, got_w = j2_rates(N_SK, I_SK, E_SK)
        self.assertAlmostEqual(got_o, want_o, places=16)
        self.assertAlmostEqual(got_w, want_w, places=16)


class TestLockXY(unittest.TestCase):
    def test_sk_walk_near_zero_over_60_days(self):
        omega_dot, argp_dot = j2_rates(N_SK, I_SK, E_SK)
        t0 = T0
        raan0, argp0, m0 = 12.0, 40.0, 80.0
        xs: list[float] = []
        ys: list[float] = []
        for day in range(61):
            t = t0 + timedelta(days=day)
            dt = (t - t0).total_seconds()
            raan = raan0 + omega_dot * dt
            argp = argp0 + argp_dot * dt
            mean_anom = m0 + deg_per_sec(N_SK) * dt
            x, y = lock_xy(
                argp=argp,
                mean_anomaly=mean_anom,
                mean_motion=N_SK,
                raan=raan,
                epoch=t,
                t=t,
                n_shell=N_SK,
                omega_dot_deg_s=argp_dot,
                Omega_dot_deg_s=omega_dot,
                t0=t0,
            )
            xs.append(x)
            ys.append(y)
        self.assertLess(max(xs) - min(xs), 1e-9)
        self.assertLess(max(ys) - min(ys), 1e-9)
        self.assertAlmostEqual(xs[0], (argp0 + m0) % 360.0, places=9)
        self.assertAlmostEqual(ys[0], raan0 % 360.0, places=9)

    def test_u16_roundtrip(self):
        self.assertEqual(pack_u16(0), 0)
        self.assertEqual(pack_u16(360), 0)
        self.assertEqual(unpack_u16(0), 0.0)
        self.assertAlmostEqual(unpack_u16(32768), 180.0, places=12)
        self.assertEqual(pack_u16(unpack_u16(12345)), 12345)


if __name__ == "__main__":
    unittest.main()
