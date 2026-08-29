"""2021 orbit math from Animation_vertical.Satellite — keep these formulas as-is."""

from __future__ import annotations

import math
from datetime import datetime

G = 6.674315e-11
M = 5.97237e24
R = 6378135

REFERENCE_TIME = datetime(2019, 11, 14, 0, 0, 0)
REFERENCE_ANOMALY = 272.587
AVG_MEAN_MOTION = 15.05584
REF_DEG_PER_SEC = 360 * AVG_MEAN_MOTION / (24 * 60 * 60)
REFERENCE_RAAN = 263.7722
RAAN_CHANGE_PER_SEC = -5.19575e-05
MAGIC_ANOMALY_FACTOR = REF_DEG_PER_SEC / 1800


def altitude_km(mean_motion: float, ecc: float) -> float:
    a = (G * M / (mean_motion * 2 * math.pi / (24 * 3600)) ** 2) ** (1 / 3)
    return (a * math.sqrt(1 - ecc * ecc / 2) - R) / 1000


def deg_per_sec(mean_motion: float) -> float:
    return 360 * mean_motion / (24 * 3600)


def anomaly_at(
    *,
    argp: float,
    mean_anomaly: float,
    mean_motion: float,
    epoch: datetime,
    t: datetime,
) -> float:
    return (
        REFERENCE_ANOMALY
        + argp
        + mean_anomaly
        + deg_per_sec(mean_motion) * (t - epoch).total_seconds()
        - (t - REFERENCE_TIME).total_seconds() * REF_DEG_PER_SEC
        - MAGIC_ANOMALY_FACTOR * (epoch - REFERENCE_TIME).total_seconds()
    ) % 360


def raan_at(*, raan: float, epoch: datetime) -> float:
    return (
        REFERENCE_RAAN
        + raan
        + RAAN_CHANGE_PER_SEC * (REFERENCE_TIME - epoch).total_seconds()
    ) % 360


def position_at(sat, t: datetime) -> tuple[float, float]:
    return (
        anomaly_at(
            argp=sat.argp,
            mean_anomaly=sat.mean_anomaly,
            mean_motion=sat.mean_motion,
            epoch=sat.epoch,
            t=t,
        ),
        raan_at(raan=sat.raan, epoch=sat.epoch),
    )
