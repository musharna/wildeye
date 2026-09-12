# Bio gap layers — 2026-09-12

**Trigger:** user asked "What biological layers are we missing?" then "Integrate all of these autonomously".
**Goal:** fill the eleven gaps named in that answer, one pipeline + client layer each, legal row per source, key-gated ones read `~/.config/wildeye/env` and skip cleanly when the key is absent (storing commands handed to the user, never asked in chat).

| # | id | token | source | contract | key |
|---|----|-------|--------|----------|-----|
| 1 | cetaceans | ce | NOAA NEFSC passive-acoustic cetacean detections | site-series | none |
| 2 | arbonet | ar | CDC ArboNET arboviral cases | polygon | none |
| 3 | neon-vectors | nv | NEON ticks DP1.10093.001 + mosquitoes DP1.10043.001 | site-series | NEON_TOKEN (have) |
| 4 | h5n1 | h5 | Nextstrain avian-flu H5N1 | point (dated) | none |
| 5 | ecoregions | ec | RESOLVE Ecoregions 2017 | polygon (static) | none |
| 6 | protected-areas | pa | WDPA / Protected Planet | polygon (static) | WDPA_TOKEN |
| 7 | fishing | fs | GFW 4wings fishing effort | polygon or grid | GFW_API_KEY (have) |
| 8 | phenology | ph | USA-NPN status/intensity | point (dated) | none |
| 9 | fires | fi | NASA FIRMS VIIRS active fire | point (dated) | FIRMS_MAP_KEY if needed |
| 10 | rivers | rv | USGS NWIS temperature + discharge | site-series | none |
| 11 | drought | dr | US Drought Monitor weekly | polygon | none |
| 12 | iucn | — | IUCN Red List category enrichment of sightings taxa | enrichment | IUCN_TOKEN |

Rules: builders touch only their own files (pipeline/<id>.py, tests, run_<id>.sh, src/data/<id>.js + test, seed); wiring (layerState, main.js, credits, voice, seed.sh, .gitignore, cron, DATA_SOURCES.md) done centrally after each delivery. Email-gated sources are declined. Licence read live before shipping.

Status: dispatched 2026-09-12.
## Outcome (2026-09-12)
- **Wired + live-run + real-app smoke (10/10):** arbonet `ar`, phenology `ph`, neon-vectors `nv`, cetaceans `ce`, drought `dr`, h5n1 `h5`, fires `fi`, ecoregions `ec`, rivers `rv` → 44 layers.
- **Built, not wired (token needed):** fishing `fs` (needs a Global Fishing Watch token; `GFW_API_KEY` is the Forest Watch key), IUCN badge (needs `IUCN_TOKEN`; seed limited to category/year/citation/url/scope).
- **Declined:** protected-areas (WDPA terms forbid downloadable redistribution; permission is email-gated). H5N1 GISAID-fed builds declined; open USDA/GenBank builds used (US only).
- **Substitutions:** arbonet is state-level weekly NNDSS (no current-year county data); rivers uses the modern USGS OGC API (legacy WaterServices decommissioning).
- **Bugs caught by the real-app smoke + independent visual critic (not by unit tests):**
  1. rivers: negative tidal discharge → `log10(q+1)` NaN pixelSize → Cesium render loop stopped. Fixed: size by magnitude.
  2. all bio point layers: `disableDepthTestDistance: Infinity` drew far-side markers through the globe (Africa's fires over the Pacific). Fixed: 50 km, guard test across 10 layers.
  3. arbonet: zero-case states were omitted → bare imagery (AK/MT/VT/WV). Fixed: every state shape drawn, grey when zero.
  4. first smoke screenshots were worthless (street-level camera + first-run dialog); critic caught it before I trusted a 9/9 PASS.
- Model switch mid-run: all 12 Fable builders died at the usage limit; relaunched on Opus 5 as resume-from-partial briefs.

