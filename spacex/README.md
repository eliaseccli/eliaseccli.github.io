# SpaceX

Public page `/spacex/` ("SpaceX Launches" in the menu; `/projects/spacex/` and `/projects/starship/` redirect here): a monochrome 3D globe in the style of the SpaceX webcast, showing the next SpaceX launch of any vehicle (Falcon 9, Falcon Heavy, Starship) with a scrubbable mission clock.

- Mission: Launch Library 2 (`ll.thespacedevs.com`, falls back to `lldev`), SpaceX (`lsp__id=121`) upcoming + previous launches, cached in localStorage for 30 min, baked fallback for offline.
- Which launch: the next one when it has orbit data (a CelesTrak pre-launch set) or is about to fly; otherwise the last flown launch with catalogued orbit data ("Last flight"), with a live countdown line to the next one. Re-checked every 10 min, so it switches by itself.
- Orbit, in order: CelesTrak SupGP pre-launch set (FILE= guesses from the mission, e.g. `starlink-g15-18`, `starship-flight-16`, mission slug), propagated with satellite.js (SGP4); for a flown launch its objects in CelesTrak's last-30-days SATCAT/GP (matched by launch date + range; plane and altitude only, node regressed to T-0 with J2); Starship `STARSHIP-<flight>` SATCAT/GP; else a labelled nominal profile from the pad and LL2 orbit class (Starbase 30.5°, Vandenberg Starlink 53/70/97.6°, Florida Starlink 43/53°, ISS 51.6°, SSO 97.6°, GTO via a ~28.5° parking orbit).
- Earth: NASA Blue Marble (public domain), pre-desaturated into `assets/earth-mono-*.jpg`.
- Vendor: three.js r170 (MIT) and satellite.js 5.0.0 (MIT) from the shared `/vendor/`; Barlow font (OFL).
- URL params: `?mission=next|latest`, `?t=<seconds from T-0>`, `?fixture=f14-prelaunch|florida|florida-hls|f9-vandenberg|f9-florida|f9-iss|last-flight`. Debug: `window.__spacex()`.
