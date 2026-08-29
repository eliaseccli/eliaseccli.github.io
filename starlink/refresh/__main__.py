from __future__ import annotations

import argparse
import sys
from pathlib import Path

from refresh.dump import dump_sats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="refresh")
    sub = parser.add_subparsers(dest="cmd", required=True)
    dump = sub.add_parser("dump")
    dump.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    if args.cmd != "dump":
        return 2
    payload = dump_sats(Path(args.out))
    print(
        f"wrote {args.out}: {payload['n']} sats in {len(payload['shells'])} shells "
        f"(catalog {payload['catalog']}, epoch {payload['epoch']})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
