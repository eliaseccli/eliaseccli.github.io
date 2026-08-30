# Starlink timeline frames

Monthly `STLK` v1 bins under `v1/`. The player is **15 fps**, one day per frame
(~3 minutes for 2655 days). `catalog.json` may still say `"fps": 30`; the
player uses 15 either way.

`(x, y)` in each frame is J2 pile-lock (not the 2019 global clock used by the
today-view `sats.json`). Binary layout is unchanged: 32-byte header, per-day
date + flags + catalog bitmask + `u16` x/y pairs.

`shell_refs.json` freezes `(n, i, e)` the first time a tight stationkeeping
pile is seen. The daily Action appends new piles only; it never edits frozen
numbers. This committed file starts empty (`piles: []`). Replace it when
historical frames are rebuilt.

## Rebuild from Space-Track yearly TLEs

Yearly 2-line files named `starlink_YYYY.tle`. Does not modify the TLE files.

```
cd /path/to/eliaseccli.github.io
PYTHONPATH=starlink TLE_DIR=/workspace/spacetrack-tles \
  python3 -m refresh.pack_timeline --out /workspace/starlink-timeline/out-j2
```

Range is 2019-05-24 through the latest TLE day. Writes `STATUS.txt` year by
year plus `catalog.json`, `shell_refs.json`, `manifest.json`, and `v1/*.bin`.

Do not commit `.tle` files (`*.tle` is gitignored). Do not fetch Space-Track
from GitHub Actions; the daily workflow only dumps `sats.json` and appends
today’s GP JSON into the current month bin.
