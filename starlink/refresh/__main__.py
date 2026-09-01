from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from refresh.append_day import TimelineSkip, append_today
from refresh.dump import dump_sats
from refresh.wipeout import apply_hole_fill


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="refresh")
    sub = parser.add_subparsers(dest="cmd", required=True)
    dump = sub.add_parser("dump")
    dump.add_argument("--out", required=True)
    dump.add_argument("--timeline", default="starlink/timeline")
    dump.add_argument("--date", default="", help="Frame date YYYY-MM-DD (default: UTC today)")
    ap = sub.add_parser("append-day", help="Append today's J2-locked timeline day from cached GP JSON")
    ap.add_argument("--timeline", default="starlink/timeline")
    ap.add_argument("--gp", default="", help="GP JSON path (default: STARLINK_CACHE/starlink_gp.json)")
    ap.add_argument("--date", default="", help="Frame date YYYY-MM-DD (default: UTC today)")
    fill = sub.add_parser(
        "fill-holes",
        help="Replace 20%+ catalog wipeouts, hold 1-day dropouts, 3-day smooth",
    )
    fill.add_argument("--timeline", default="starlink/timeline")
    args = parser.parse_args(argv)
    if args.cmd == "dump":
        payload = dump_sats(
            Path(args.out),
            timeline_dir=Path(args.timeline),
            frame_date=date.fromisoformat(args.date) if args.date else None,
        )
        print(
            f"wrote {args.out}: {payload['n']} sats in {len(payload['shells'])} shells "
            f"(catalog {payload['catalog']}, epoch {payload['epoch']})"
        )
        return 0
    if args.cmd == "append-day":
        try:
            info = append_today(
                Path(args.timeline),
                gp_path=Path(args.gp) if args.gp else None,
                frame_date=date.fromisoformat(args.date) if args.date else None,
            )
        except TimelineSkip as exc:
            print(f"timeline append skipped: {exc}")
            return 2
        wiped = " wipeout" if info.get("wipeout") else ""
        print(
            f"timeline {info['date']}: {info['n']} sats, catalog {info['catalog']}, "
            f"piles {info['piles']} pending {info['pending']}{wiped} "
            f"end {info.get('end', info['date'])} -> {info['month']}"
        )
        return 0
    if args.cmd == "fill-holes":
        info = apply_hole_fill(Path(args.timeline))
        print(
            f"filled {len(info['synthetic'])} synthetic days, "
            f"end {info['last_real']}, days {info['days']}"
        )
        if info["synthetic"]:
            print("synthetic: " + ", ".join(info["synthetic"]))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
