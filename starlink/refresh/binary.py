"""STLK v1 monthly timeline bins. Layout matches starlink/timeline.js decodeMonth."""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = b"STLK"
VERSION = 1
HEADER_SIZE = 32


@dataclass
class DayFrame:
    date: int  # YYYYMMDD
    flags: int = 0
    slots: list[int] = field(default_factory=list)
    xs: list[int] = field(default_factory=list)  # u16
    ys: list[int] = field(default_factory=list)  # u16


@dataclass
class MonthBin:
    year: int
    month: int
    catalog_len: int
    first_date: int
    days: list[DayFrame] = field(default_factory=list)


def ymd_int(y: int, m: int, d: int) -> int:
    return y * 10000 + m * 100 + d


def encode_month(bin_: MonthBin) -> bytes:
    days = sorted(bin_.days, key=lambda d: d.date)
    n_days = len(days)
    first = days[0].date if days else bin_.first_date
    header = bytearray(HEADER_SIZE)
    header[0:4] = MAGIC
    header[4] = VERSION
    struct.pack_into("<HBBII", header, 8, bin_.year, bin_.month, n_days, bin_.catalog_len, first)
    parts = [bytes(header)]
    mask_bytes = math.ceil(bin_.catalog_len / 8) if bin_.catalog_len else 0
    for day in days:
        pairs = sorted(zip(day.slots, day.xs, day.ys), key=lambda t: t[0])
        mask = bytearray(mask_bytes)
        xs: list[int] = []
        ys: list[int] = []
        for slot, x, y in pairs:
            if slot < 0 or slot >= bin_.catalog_len:
                continue
            mask[slot >> 3] |= 1 << (slot & 7)
            xs.append(int(x) & 0xFFFF)
            ys.append(int(y) & 0xFFFF)
        parts.append(struct.pack("<I", int(day.date)))
        parts.append(struct.pack("<Bxxx", int(day.flags) & 0xFF))
        parts.append(bytes(mask))
        xy = bytearray()
        for x, y in zip(xs, ys):
            xy += struct.pack("<HH", x, y)
        parts.append(bytes(xy))
    return b"".join(parts)


def decode_month(data: bytes) -> MonthBin:
    if len(data) < HEADER_SIZE:
        raise ValueError("timeline bin too short")
    if data[0:4] != MAGIC:
        raise ValueError("bad timeline magic")
    if data[4] != VERSION:
        raise ValueError("unsupported timeline version")
    year, month, n_days, catalog_len, first_date = struct.unpack_from("<HBBII", data, 8)
    mask_bytes = math.ceil(catalog_len / 8) if catalog_len else 0
    off = HEADER_SIZE
    days: list[DayFrame] = []
    for _ in range(n_days):
        if off + 8 + mask_bytes > len(data):
            raise ValueError("truncated timeline day header")
        date = struct.unpack_from("<I", data, off)[0]
        flags = data[off + 4]
        off += 8
        slots: list[int] = []
        for i in range(catalog_len):
            if data[off + (i >> 3)] & (1 << (i & 7)):
                slots.append(i)
        n = len(slots)
        if off + mask_bytes + n * 4 > len(data):
            raise ValueError("truncated timeline coords")
        off += mask_bytes
        xs: list[int] = []
        ys: list[int] = []
        for _i in range(n):
            x, y = struct.unpack_from("<HH", data, off)
            off += 4
            xs.append(x)
            ys.append(y)
        days.append(DayFrame(date=date, flags=flags, slots=slots, xs=xs, ys=ys))
    return MonthBin(
        year=year,
        month=month,
        catalog_len=catalog_len,
        first_date=first_date,
        days=days,
    )


def read_month(path: Path) -> MonthBin:
    return decode_month(path.read_bytes())


def write_month(path: Path, bin_: MonthBin) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_month(bin_))


def upsert_day(bin_: MonthBin, day: DayFrame, catalog_len: int) -> MonthBin:
    """Replace or append a day; expand catalog_len (old days keep their slots)."""
    bin_.catalog_len = max(bin_.catalog_len, catalog_len)
    kept = [d for d in bin_.days if d.date != day.date]
    kept.append(day)
    kept.sort(key=lambda d: d.date)
    bin_.days = kept
    if kept:
        bin_.first_date = kept[0].date
    return bin_
