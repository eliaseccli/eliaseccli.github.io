"""J2 pile-lock rates and (x, y) packing shared by the Action and the packer.

Earth constants match refresh.orbit (G, M, R). J2 is the EGM96 C20 value.
Verified on STARLINK-30514 (NORAD 58028), 2025-06-29..2025-08-28, 53° ~475 km:
J2 Omega_dot vs TLE dRAAN was 0.0006 deg/day.
"""

from __future__ import annotations

import math
from datetime import datetime

from refresh.orbit import G, M, R, deg_per_sec

MU = G * M
J2 = 1.08262668e-3
T0 = datetime(2019, 5, 24, 12, 0, 0)
T0_ISO = "2019-05-24T12:00:00"


def j2_rates(n_rev_day: float, inc_deg: float, e: float) -> tuple[float, float]:
    """Return (Omega_dot, omega_dot) in deg/s from mean motion, inclination, ecc."""
    n = n_rev_day * 2.0 * math.pi / 86400.0
    a = (MU / n**2) ** (1.0 / 3.0)
    i = math.radians(inc_deg)
    fac = J2 * (R / a) ** 2 / (1.0 - e * e) ** 2
    omega_dot = math.degrees(-1.5 * n * fac * math.cos(i))
    argp_dot = math.degrees(0.75 * n * fac * (4.0 - 5.0 * math.sin(i) ** 2))
    return omega_dot, argp_dot


def lock_xy(
    *,
    argp: float,
    mean_anomaly: float,
    mean_motion: float,
    raan: float,
    epoch: datetime,
    t: datetime,
    n_shell: float,
    omega_dot_deg_s: float,
    Omega_dot_deg_s: float,
    t0: datetime = T0,
) -> tuple[float, float]:
    """Anomaly / RAAN at noon of the frame date, locked to the pile clock."""
    u = argp + mean_anomaly + deg_per_sec(mean_motion) * (t - epoch).total_seconds()
    x = (u - (deg_per_sec(n_shell) + omega_dot_deg_s) * (t - t0).total_seconds()) % 360.0
    y = (raan + Omega_dot_deg_s * (t0 - epoch).total_seconds()) % 360.0
    return x, y


def pack_u16(deg: float) -> int:
    """STLK v1 angle: round(deg * 65536 / 360) % 65536."""
    return int(round((deg % 360.0) * 65536.0 / 360.0)) % 65536


def unpack_u16(u16: int) -> float:
    return (u16 * 360.0) / 65536.0


def noon_utc(d) -> datetime:
    """Naive UTC noon of a date or datetime."""
    if isinstance(d, datetime):
        return datetime(d.year, d.month, d.day, 12, 0, 0)
    return datetime(d.year, d.month, d.day, 12, 0, 0)
