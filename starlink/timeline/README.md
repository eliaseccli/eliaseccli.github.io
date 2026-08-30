# Starlink timeline frames

Monthly `STLK` v1 bins under `v1/`. The player defaults to **15 fps** (adjustable
1–15), one day per frame (~3 minutes for 2655 days at 15 fps). `catalog.json`
may still say `"fps": 30`; the player does not read that field.

`(x, y)` in each frame — and in today-view `sats.json` — is J2 pile-lock at
noon UTC of the frame date. Binary layout is unchanged: 32-byte header, per-day
date + flags + catalog bitmask + `u16` x/y pairs.

`shell_refs.json` freezes `(n, i, e)` after **5 tight-pile sightings** at the
same inclination whose mean motion stays within `|n − n0| ≤ 0.005` of the
**first-day** `n` (pending identity; `n` is never chased). Peak-km is a label
only. A miss of up to 2 days does not reset the streak. 460/463/465 stay
separate; a one-week descent smear or a slow climb of 0.004/day does not
freeze. Only a tight clump of **≥ 50** sats (`CLOCK_MIN_COUNT`) may freeze as
its own pile clock. `detect_peaks` min_count stays **25** for km checkboxes /
`listed_shells`. Pending streaks live in
`pending: [{inc, km, n, i, e, streak, last}]`
so the daily Action can finish a freeze across runs. Frozen numbers are never
edited. Replace this file when historical frames are rebuilt.

Once a pile exists it stays a valid clock; today's occupancy does not revoke
it. A sat uses a frozen pile's `n/i/e` only when `|n_sat − n_pile| ≤ 0.005`
(`kind=pile` if in today's matched members, else `kind=draft`). Never assign
a pile clock when `|Δn| > 0.005`, and never draft leftovers onto a far shell.
Unmatched sats at one inclination share one `kind=clump` clock: that day's
median `n, i, e`. Odd-inclination loners stay `kind=own`. There is no
per-sat continuity offset and no held-own-n. `lock_state.json` stores
per-sat `n, i, e, pile_id, ox, oy, x, y, kind` with `ox=oy=0` (last `x,y`
are for same-day reuse and pile EMA). Light circular EMA (α=0.4) applies
only to `kind=pile` when the clock did not change that day.

## Rebuild from Space-Track yearly TLEs

Yearly 2-line files named `starlink_YYYY.tle`. Does not modify the TLE files.

```
cd /path/to/eliaseccli.github.io
PYTHONPATH=starlink TLE_DIR=/workspace/spacetrack-tles \
  python3 -m refresh.pack_timeline --out /workspace/starlink-timeline/out-j2
```

Range is 2019-05-24 through the latest TLE day. Writes `STATUS.txt` year by
year plus `catalog.json`, `shell_refs.json`, `lock_state.json`, `manifest.json`,
and `v1/*.bin`.

Do not commit `.tle` files (`*.tle` is gitignored). Do not fetch Space-Track
from GitHub Actions; the daily workflow appends today’s GP JSON (and
`lock_state.json`) into the current month bin, then dumps `sats.json`.
