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
