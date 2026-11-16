# Starship

Gated project page (`/projects/starship/`): a monochrome 3D globe in the style of the SpaceX webcast, showing the next (or most recent) Starship flight with a scrubbable mission clock.

- Mission: Launch Library 2 (`ll.thespacedevs.com`, falls back to `lldev`), cached in localStorage for 30 min, baked fallback for offline.
- Orbit: CelesTrak SATCAT `STARSHIP-<flight>` (inclination/apogee/perigee) and, while the ship is still in orbit, its GP/TLE propagated with satellite.js (SGP4). Otherwise a labelled nominal profile from the pad, shaped by the mission description (altitude, orbits, hours, return to launch site).
- Earth: NASA Blue Marble (public domain), pre-desaturated into `assets/earth-mono-*.jpg`.
- Vendor: three.js r170 (MIT), satellite.js 5.0.0 (MIT), Barlow font (OFL).
- URL params: `?mission=next|latest`, `?t=<seconds from T-0>`.
