/* Which SpaceX launch the globe should show.
   Selection is by liftoff time only. Orbit data (CelesTrak) is used later
   to draw the path; a classified or not-yet-catalogued mission is still
   the next launch, the one in flight, or the last flight. LL2 may leave a
   just-flown launch in "upcoming", or lag in "previous", so both lists are
   one pool. */

export const LIVE_BEFORE = 3600, LIVE_AFTER = 3 * 3600; // s around T-0 that count as "flying now"

export const lkey = (l) => (l ? (l.name || "") + "@" + l.net : "");

const tOf = (l) => new Date(l.net).getTime();
const failed = (l) => /^failure$/i.test((l.status || {}).abbrev || "");

export function classifyLaunches(data, now, pin) {
  const seen = new Set(), all = [];
  for (const l of [...(data.upcoming || []), ...(data.previous || [])]) {
    if (!l || !l.net || seen.has(lkey(l))) continue;
    seen.add(lkey(l));
    all.push(l);
  }
  const flying = all
    .filter((l) => !failed(l) && tOf(l) <= now && tOf(l) > now - LIVE_AFTER * 1000)
    .sort((a, b) => tOf(b) - tOf(a));
  const flyKeys = new Set(flying.map(lkey));
  const up = all
    .filter((l) => !failed(l) && tOf(l) > now && !flyKeys.has(lkey(l)))
    .sort((a, b) => tOf(a) - tOf(b));
  const prev = all
    .filter((l) => !failed(l) && tOf(l) <= now && !flyKeys.has(lkey(l)))
    .sort((a, b) => tOf(b) - tOf(a));
  const next = (pin && flying.find((l) => lkey(l) === pin)) || flying[0] || up[0] || null;
  // most recent flown launch, whether or not CelesTrak has catalogued it
  const latest = prev[0] || null;
  return { all, flying, up, prev, next, latest };
}

export function chooseSide(which, next, latest) {
  const auto = next ? "next" : "latest";
  const sideWanted = which === "auto" || !which ? auto : which;
  const chosen = sideWanted === "next" ? (next || latest) : (latest || next);
  const side = chosen === next ? "next" : "latest";
  return { auto, which: side, chosen };
}
