# Data Sources & Attribution

God's Eye View's **code** is [MIT](LICENSE)-licensed. **The MIT grant covers the source code only — it does NOT extend to third-party data or visual assets.** Every third-party source keeps its own license and terms. This file documents the live and bundled data sources; bundled 3D-model provenance is recorded in [`public/models/README.md`](public/models/README.md).

How to read this:

- **The non-permissive datasets are carved out, not omitted.** Some bundled data (e.g. TeleGeography, CC BY-NC-SA) isn't MIT-compatible. Rather than hide it, we **bundle it with a clear license carve-out** so the app works out of the box — but it stays under the provider's terms.
- **If your use doesn't fit a dataset's license, remove that dataset.** Most importantly: TeleGeography is **NonCommercial** — commercial users must delete it (or license it from TeleGeography). It's one self-contained folder.
- **Attribution is shown in-app** and listed here. Keep it intact. The required Google/Cesium credit renders on the on-globe credit line (bottom-left, `#cesium-credits`), and every per-layer credit below is registered into the expandable **"Data attribution"** lightbox on that line (`src/data/dataCredits.js` → `viewer.creditDisplay.addStaticCredit`). Both stay visible in clean-view and recording modes.
- **Bundled model attribution lives beside the model files.** [`public/models/README.md`](public/models/README.md) records each shipped model's creator, source, license, and modification status.

---

## Live sources (fetched at runtime — not stored in this repo)

| Source | Used for | License / terms | Attribution |
|--------|----------|-----------------|-------------|
| **Google Map Tiles API** (Photorealistic 3D Tiles) + Places/Geocoding | The 3D globe, voice scene context, and on-demand nearby installation search | Google Maps Platform ToS (proprietary, your own key + billing) | "Google" / "Google Maps" logo — **shown in-app**, required |
| **OpenSky Network** | Primary worldwide live-flight snapshot | Non-commercial research/education license | Schäfer et al., *"Bringing Up OpenSky"*, IPSN 2014 + opensky-network.org |
| **adsb.lol point API** | Bounded live-flight fallback when OpenSky has no usable snapshot | ODbL 1.0 | adsb.lol contributors; `api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}` |
| **adsb.lol** | Military flights + aircraft traces | ODbL 1.0 | "adsb.lol" (ODbL) |
| **AISStream.io** | Live vessels (AIS) | Free, beta, no formal ToS; AIS is a public broadcast | "AISStream.io" (courtesy) |
| **CelesTrak** | Satellite TLEs (SGP4) | US-government-origin data, no license; citation requested | "CelesTrak (celestrak.org), Dr. T.S. Kelso" |
| **The Space Devs — Launch Library 2 v2.3** | Recent launch, payload, stage, and recovery metadata for Space Missions (30d) | [The Space Devs terms of use](https://github.com/TheSpaceDevs/Tutorials/blob/main/faqs/faq_TSD.md#terms-of-use): data may be used and shared in any form; avoid forwarding it without added value; attribution is encouraged (not mandatory). [Official API limits](https://ll.thespacedevs.com/docs/): 15 unauthenticated calls/hour; optional token | "Launch Library 2 — The Space Devs" (courtesy attribution) |
| **Esri World Imagery** (ArcGIS Online tile service) | The keyless satellite basemap — the default landing when no Google/ion credential is configured, and the "Esri Satellite" map stack | [Esri Master Agreement](https://www.esri.com/en-us/legal/terms/full-master-agreement): the public World Imagery service is usable in public-facing apps with attribution; no key is required for this classic endpoint, but Esri governs and can change access — an app at scale should review current ArcGIS Location Platform terms | "Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" (provider carries the service's own credit line) |
| **USGS** | Earthquakes | U.S. public domain | "Data courtesy of the U.S. Geological Survey" |
| **OpenStreetMap (Overpass API)** | Road geometry for traffic | ODbL 1.0 | "© OpenStreetMap contributors" |
| **TomTom Traffic API** (flow vector tiles) | Live congestion coloring for the traffic layer (optional, BYOK) | [TomTom for Developers terms](https://developer.tomtom.com) (proprietary, your own key; free tier currently 200K tile requests/month — see [current pricing](https://docs.tomtom.com/pricing/)) | "Traffic flow data © TomTom" — registered when live mode activates |
| **OpenStreetMap (Overpass API)** | Viewport-bounded mapped installation context for Global Context | ODbL 1.0 | "© OpenStreetMap contributors" (incomplete mapped context) |
| **OpenStreetMap (Nominatim)** | Reverse-geocoded place label in the cockpit Local Info page | ODbL 1.0 + Nominatim usage policy | "© OpenStreetMap contributors" |
| **Open-Meteo** | Current weather in the cockpit Local Info page and cockpit-local dynamic atmospheric effects | [CC BY 4.0 data licence and adjacent-link attribution requirement](https://open-meteo.com/en/licence) | Linked "Weather data by Open-Meteo.com" beside the displayed local data |
| **Google News RSS** | Primary locality-matched headlines in the cockpit Regional News page | [Google News Terms of Service](https://www.google.com/intl/en_us/terms_google_news.html) restrict use to personal, noncommercial use; linked articles remain third-party publisher content and retain publisher terms | "Google News RSS" plus each article's linked publisher/domain |
| **GDELT Project DOC 2.0** | Fail-soft fallback for location-matched cockpit headlines | [GDELT Terms of Use](https://www.gdeltproject.org/about.html#termsofuse): unrestricted academic/commercial/governmental dataset use, with citation and link required; linked articles retain publisher terms | "GDELT Project" plus each article's linked publisher/domain |
| **City of Austin Open Data** | CCTV camera catalog + frames | City of Austin Open Data Terms of Use | "City of Austin, TX — data.austintexas.gov" |
| **Caltrans (cwwp2.dot.ca.gov)** | CCTV camera catalogs + frames, California districts | Public Caltrans traffic camera data | "Caltrans — cwwp2.dot.ca.gov" (courtesy) |
| **TfL Open Data (JamCams)** | CCTV camera catalog + frames, London | [TfL Open Data terms](https://tfl.gov.uk/info-for/open-data-users/) — attribution REQUIRED | "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights" |
| **GBFS (Lyft / BCycle)** | Bikeshare availability | Per-feed (attribution-only) | Credit the operator (e.g. Austin BCycle) + its `license_url` |
| **Radio Browser** | Geolocated internet-radio station directory and station-level tags | Public-domain directory data under PDDL 1.0; individual broadcaster stream terms apply | "Radio Browser" plus a link to the selected broadcaster |
| **Re:Earth Terrain** (Mapterhorn) | Terrain (keyless globe stacks — OSM etc. — + `/api/terrain/heights` ellipsoidal-height lookups) | Terrain mesh: CC BY 4.0; geoid: EGM2008 (NGA, public domain) | "Terrain (keyless globe stacks): Re:Earth Terrain / Mapterhorn (CC BY 4.0) / EGM2008 (NGA)" |

### Notes on the live sources

- **Google Maps Platform.** You supply your own API key and are bound by [Google's ToS](https://cloud.google.com/maps-platform/terms). Google Maps Content (tiles, geocodes, places) **may not be cached, stored, rehosted, or committed** — this app only ever uses it live, which is the compliant pattern. The "Google" attribution is displayed on the globe and must stay visible. Restrict your key (see [SECURITY.md](SECURITY.md)).
- **OpenSky Network.** Its license is **non-commercial**, and operational use of the REST API in a live product can require a prior written agreement with OpenSky — even for non-profit/government use. If you deploy this commercially, contact OpenSky for your own terms. The flights layer is a toggle and runs anonymously by default.
- **adsb.lol flight fallback.** When OpenSky is unavailable and no last-good OpenSky response exists, the server requests a cached, capped 250 nm adsb.lol point snapshot around the current camera subpoint. This is regional observed context, not worldwide completeness; provenance is exposed in the Flights stats/context row. Military ICAOs remain reconciled through the existing dedicated military registry rather than duplicated.
- **Launch Library 2.** `/api/launches` makes a server-side rolling-30-day query against the supported v2.3 detailed launch endpoint, caches successful responses for 15 minutes in memory and on disk, and serves the last successful response during a throttle or transient outage. Anonymous access is limited to 15 calls/hour; deployments can provide `LL2_API_TOKEN` for authenticated access. The Space Devs' published terms permit using and sharing the API data in any form, ask users not to forward it without adding value, disclaim complete accuracy, and encourage—but do not require—attribution. This app keeps a courtesy credit. Payload and stage/recovery records are shown only when supplied. Failed launches expose their source status and never receive fallback orbit geometry or a live/estimated marker. LL2 supplies launch context and event timing, not continuous ascent telemetry or live orbital state.
- **TfL JamCams.** The camera list comes from the keyless `api.tfl.gov.uk` endpoint (an optional `TFL_APP_KEY` raises its rate limit); frames come from TfL's public S3 bucket. The "Powered by TfL Open Data" attribution is required by TfL's terms and is registered in the Data attribution popover.
- **Radio Browser.** `/api/radio/stations` discovers official API mirrors, makes bounded and coalesced healthy/geolocated HTTPS-station queries, caches the normalized public-domain directory for 45 minutes, and may serve the last good catalog for up to seven days during an outage. Refreshes must meet minimum accepted-query and station coverage before replacing a warm catalog; schema-valid responses whose rows all fail the product's health policy do not count as successful queries. A usable partial cold catalog is explicitly `DEGRADED`, and malformed or empty successful payloads are rejected atomically. Every directory and click-count request rejects redirects, validates all resolved addresses as globally routable (including reserved/documentation IPv4 and special/non-global IPv6 exclusions), and pins the TLS connection to a validated address. Only MP3/AAC non-HLS directory rows with public HTTPS stream targets are returned; favicons are intentionally omitted. Pressing play connects one browser audio element directly to the selected broadcaster and calls the directory's click counter through known-ID-only `POST /api/radio/click/:uuid`. GEV never proxies, caches, records, bundles, or redistributes audio. Radio Browser supplies station-level tags, not dependable current-song or upcoming-program metadata, so Radio filtering never claims either. Direct playback exposes the listener's IP address to the broadcaster, whose own stream terms apply.
- **TomTom Traffic.** Optional and BYOK: without `TOMTOM_API_KEY` the traffic layer runs its built-in simulation and no TomTom data (or attribution) appears. With a key, flow vector tiles are fetched through the server-side `/api/tomtom` proxy (120 s cache + a daily tile-budget governor — `TOMTOM_DAILY_TILE_BUDGET`, default 40,000, a configurable application safety ceiling, not a guarantee of staying within TomTom's monthly free allowance; TomTom's [current pricing](https://docs.tomtom.com/pricing/) lists 200K free tile requests per month) and the "Traffic flow data © TomTom" credit is registered in the Data attribution popover the moment live mode activates. TomTom data is served live and cached only transiently (≤120 s TTL under `.gev-cache/`, gitignored) — it is not bundled or redistributed. One 23 KB point-in-time tile snapshot is committed as a decode-test fixture (`src/data/fixtures/`, © TomTom, never served to the app).
- **Re:Earth Terrain.** Keyless (no API key). Used two ways: (1) `src/mapStackController.js` swaps in a `Cesium.CesiumTerrainProvider` pointed at Re:Earth's `cesium-mesh/ellipsoid` quantized-mesh endpoint for globe stacks without a Cesium ion token (e.g. OSM), replacing a flat `EllipsoidTerrainProvider`; falls back to the flat provider if the endpoint can't be reached. (2) The server-side `/api/terrain/heights` proxy (disk-cached, serve-stale) resolves per-point ellipsoidal ground height for entity placement. Both are best-effort with a keyless-safe fallback (bundled EGM96 geoid math) if Re:Earth is unreachable.
- **Global Context installation context.** `/api/military-installations` queries only an allow-listed subset of OSM `military=*` and `landuse=military` features inside a maximum 10° non-dateline viewport. It caches and may serve stale mapped context, but it is neither a global installation database nor evidence of capability, activity, or absence. User-requested Google Places results remain separately sourced candidates unless their returned types explicitly establish military classification; generic offices, museums, and similarly ambiguous matches are excluded from military proximity counts.
- **Cockpit regional briefing.** `/api/regional-brief` rounds aircraft coordinates into 0.1° cache cells, caches results for five minutes, and serializes Nominatim calls at no more than one request per second. Google News RSS is queried with the resolved locality/region first; GDELT is used only when that RSS query fails or is empty. Google's published Google News terms restrict that source to personal, noncommercial use, so commercial deployments must disable/replace it or obtain separate permission; GDELT permits commercial dataset use with citation. The Data attribution popover identifies the active headline sources; article links retain publisher attribution. Headlines are location-query matches, not verified incidents, risk rankings, or evidence that a location is safe. Empty, partial, stale, and unavailable source states remain distinct. Open-Meteo supplies current conditions independently of the news source. `WX OFF` disables cockpit weather rendering only; the Local Info briefing still fetches its source-backed weather values and displays the required linked Open-Meteo credit.
- **Dynamic weather presentation.** While cockpit mode is active, `/api/weather-effects` requests current Open-Meteo observations for the aircraft/camera location, rounds coordinates into 0.1° cache cells, caches results for five minutes, and may retain a stale observation for up to 30 minutes during a transient outage. WMO condition code selects the visual family; observed cloud cover, precipitation, visibility, wind speed, and wind direction bound its strength and motion. Missing or expired weather renders no synthetic atmospheric effect, and normal globe view never renders the weather overlay.

---

## Bundled snapshots (committed under `src/data/local_data/`)

Static datasets shipped in the repo for an out-of-the-box experience. **None are MIT** — each keeps its own license (see the carve-out in [LICENSE](LICENSE)). Each folder also has its own provenance README.

| Dataset | Folder | License | Commercial use? | Attribution |
|---------|--------|---------|-----------------|-------------|
| **Datacenters** (~4.3K) | `datacenters/` | **ODbL 1.0** (OpenStreetMap extract) | ✅ (attribution + share-alike on data) | "© OpenStreetMap contributors" |
| **Dams** (704) | `dams/` | **ODbL 1.0** (OpenInfraMap / OSM extract) | ✅ (attribution + share-alike on data) | "© OpenStreetMap contributors" (+ Open Infrastructure Map) |
| **TeleGeography Submarine Cable Map** (712 cables + 1,917 landing points) | `telegeography_submarine_cables/` | **CC BY-NC-SA 3.0** | ❌ **NonCommercial — remove for commercial use** | "© TeleGeography — submarinecablemap.com" |
| **Natural Earth physical regions** (1,046 land + 292 marine named polygons) | `natural_earth/` | **Public domain** | ✅ (no restrictions) | "Made with Natural Earth" (courtesy credit — not legally required) |
| **DataSF Analysis Neighborhoods** (41 SF neighborhood polygons) | `neighborhoods/` | **PDDL 1.0** (public domain) | ✅ (no restrictions) | "City & County of San Francisco — DataSF" (courtesy — not legally required) |

### ⚠️ TeleGeography is bundled but NonCommercial

The submarine-cable GeoJSON is **CC BY-NC-SA 3.0** (Attribution-**NonCommercial**-**ShareAlike**). It is bundled so the cables layer works out of the box, but it is **not covered by this project's MIT license**. CC BY-NC-SA permits redistribution with attribution and share-alike — which is exactly how it ships here — but the **NonCommercial** clause means:

> If you use God's Eye View commercially, delete `src/data/local_data/telegeography_submarine_cables/` (or obtain a commercial license from TeleGeography). It is one self-contained folder; the rest of the app runs without it.

The richer structured dataset is licensed separately/commercially by TeleGeography.

### ODbL share-alike (datacenters, dams)

The OSM-derived datasets are under the **Open Database License**. ODbL's share-alike applies to the **data / derived database, not this MIT-licensed code** — the two coexist (exactly how Open Infrastructure Map ships: MIT software + ODbL data). If you publicly distribute a *modified* version of these databases, you must offer it under ODbL. Keep the "© OpenStreetMap contributors" notice (link: https://www.openstreetmap.org/copyright).

### NASA FIRMS acknowledgement

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS).

FIRMS active fires are **fetched live at runtime** (CC0 / U.S. public domain data): the
`/api/firms` server-side proxy merges the three VIIRS NRT sources (NOAA-20, NOAA-21,
Suomi-NPP) clamped to the trailing 24 h, cached 30 min to respect the shared MAP_KEY
transaction quota. Requires a free `FIRMS_MAP_KEY`
(https://firms.modaps.eosdis.nasa.gov/api/map_key/); the layer is empty without it.
The former bundled 2026-05-25 snapshot was removed 2026-07-16.

### Natural Earth physical regions (`natural_earth/`)

Curated from the **Natural Earth 10m physical vectors** (https://www.naturalearthdata.com/ —
fetched from the canonical `nvkelso/natural-earth-vector` GitHub repo, commit
`ca96624a56bd078437bca8184e78163e5039ad19`, 2026-07-28): `ne_10m_geography_regions_polys`
(mountain ranges, deserts, plateaus, peninsulas, islands, …) → `regions.json` and
`ne_10m_geography_marine_polys` (seas, gulfs, straits, bays) → `marine.json`. They back the
voice-annotation resolver's named-natural-region lookup (`src/data/naturalEarthRegions.js`),
so "outline the Alps" draws the real range polygon offline.

Curation (provenance in each file's `meta` header): named features only, outer rings only,
Douglas-Peucker simplified at ~0.01° with coordinates rounded to 3 decimals, sub-20 km²
MultiPolygon crumbs and zero-area sliver artifacts dropped (7.3 MB source → 2.5 MB pack).

Natural Earth is **public domain** (no permission needed, no attribution legally required —
https://www.naturalearthdata.com/about/terms-of-use/). We credit anyway: "Made with Natural
Earth". Registration in the in-app `dataCredits.js` attribution list ships with the resolver
wiring (see below).

### DataSF Analysis Neighborhoods (`neighborhoods/`)

`neighborhoods/san-francisco.json` bundles the City & County of San Francisco's official
**"Analysis Neighborhoods"** dataset (41 neighborhood polygons; DataSF dataset `j2bu-swwd`,
catalog map view
[`p5b7-5n3h`](https://data.sfgov.org/Geographic-Locations-and-Boundaries/Analysis-Neighborhoods-Map/p5b7-5n3h)).
It backs the voice-annotation resolver's offline neighborhood-boundary lookup
(`src/data/neighborhoodPolygons.js`), so "outline Chinatown" draws the city's real
boundary polygon with no network dependency.

The dataset is licensed **PDDL 1.0** (Open Data Commons Public Domain Dedication and
License — public domain; the DataSF metadata declares `licenseId: "PDDL"`). No attribution
is legally required; we note the source here and in the folder's `SOURCE.md`, which records
the retrieval date (2026-07-30), exact download URL, license evidence, and the
deterministic transform (`scripts/build-sf-neighborhoods.mjs`: `nhood` → `name`, ~2 m
Douglas-Peucker simplification, 6-decimal rounding).

---

## In-app attribution

The required Google Maps / Cesium credit renders on the on-globe credit line (`#cesium-credits`, bottom-left) and must stay visible — including in clean-view and recording modes (the whole line, logo + "Google Maps" + the "Data attribution" link, stays on screen; only the GEV panels/HUD fade). The layer-specific credits (adsb.lol, TeleGeography, OSM datacenters/dams/roads, NASA FIRMS, CelesTrak, USGS, City of Austin, GBFS, Radio Browser, OpenSky, AISStream) are registered into the expandable **"Data attribution"** popover on that credit line via `viewer.creditDisplay.addStaticCredit(new Cesium.Credit(html, /* showOnScreen */ false))` — see `src/data/dataCredits.js`. When you add a new data source, add its license and attribution to this file **and** append an entry to `DATA_CREDITS` in `src/data/dataCredits.js` so it surfaces in the app.

## wildeye additions

| Layer | Source | License |
|---|---|---|
| Bird migration (radar) | NOAA NEXRAD Level II via AWS Open Data (`unidata-nexrad-level2`) | US public domain |
| (processing) | vol2bird, Dokter et al. | MIT (LICENSE file read 2026-09-11) |
| Bird migration (Europe, radar profiles) | Aloft / BALTRAD_VPTS daily CSV (`aloftdata` S3 bucket) | CC0 (doi:10.5281/zenodo.14711024) |
| Coral bleaching alert | NOAA Coral Reef Watch 5 km BAA via CoastWatch ERDDAP — **legacy 0–4 categories** (ERDDAP variable `CRW_BAA`; NOAA's site grades Alert Levels 1–5 since 2023-12-15); class 0 masked by its pinned palette colour, palette drift fails the build | US public domain; credit "NOAA Coral Reef Watch" |
| Sea surface temperature | NOAA/NCEI OISST v2.1 via CoastWatch ERDDAP | US public domain; cite Huang et al. 2020 |
| Chlorophyll-a / algal blooms | NOAA CoastWatch VIIRS S-NPP/NOAA-20 gap-filled daily 4 km via ERDDAP | US public domain ("may be used and redistributed for free") |
| Coral heat stress (DHW, HotSpot) + sea ice fraction | NOAA Coral Reef Watch 5 km via the same CoastWatch ERDDAP dataset (`CRW_DHW`, `CRW_HOTSPOT`, `CRW_SEAICE`) | US public domain; credit "NOAA Coral Reef Watch" |
| Vegetation greenness (NDVI) | NOAA NDVI Climate Data Record, VIIRS daily 0.05°, NCEI THREDDS WMS GetMap (newest file resolved from catalog.xml) | US public domain (NOAA CDR); cite the CDR product page (read 2026-09-11) |
| Animal tracks | IOOS Animal Telemetry Network ERDDAP (`pipeline/tracks.json`), newest deployments per species | per-deployment licence text shown in-app (sampled: "may be used and redistributed for free"); per-deployment citation shown | 
| Wastewater virus trend (county polygons) | CDC NWSS `data.cdc.gov` j9g8-acpt (SARS-CoV-2 samples, weekly), `pipeline/wastewater.py`; county shapes U.S. Census cartographic boundaries 2021 1:20m | Public Domain U.S. Government (licence field `USGOV_WORKS`, read 2026-09-11); rows sourced from WastewaterSCAN (CC BY-NC) are excluded; CDC non-endorsement disclaimer in credits |
| Wildlife sightings | GBIF + OBIS occurrence APIs, `pipeline/taxa.json` | per-record CC0 / CC-BY only (NC, SA, © dropped in pipeline); dataset title, publisher, DOI and record licence shown per record; capped taxa flagged `truncated` |

## wildeye licence matrix (read 2026-09-11, live pages; "could not fetch" = not verified)

Release policy: wildeye is a **free, non-commercial, open-source** app. Inherited GEV sources
(OpenSky, TeleGeography, Google News) are already non-commercial, so the whole distribution
is non-commercial; sources below are graded for that policy.

| Source | v1? | Licence (as read) | Conditions | Attribution | Read |
|---|---|---|---|---|---|
| NOAA NEXRAD L2 (AWS NODD) | **yes** | open, "use as desired" | attribution requested; no endorsement | "NEXRAD on AWS, accessed DATE, registry.opendata.aws/noaa-nexrad" | registry.opendata.aws/noaa-nexrad |
| vol2bird | **yes** | MIT | keep notice | "vol2bird (Dokter et al., MIT)" | github adokter/vol2bird LICENSE |
| Aloft VPTS (Europe) | **yes** | CC0 (Zenodo 14711024); raw OPERA volumes NOT redistributable | serve profiles only, never raw PVOL | "Aloft / BALTRAD_VPTS (CC0), doi:10.5281/zenodo.14711024" | zenodo, s41597-025-04641-5, aloftdata.eu |
| OTN detections (ERDDAP) | **v1 shipped** (site-series contract: one point per receiver with weekly per-species counts; species = 2-table join detections × tag releases on transmitter name, unjoined rows dropped; aggregate `distinct()` queries 504 → one narrow query per project; gateway 503s intermittently → 4 tries with backoff; public record ends ~1 y ago under embargo, legend states the end date) | CC BY 4.0 (OTN Data Policy 2024 §4a, read 2026-09-11) | per-project citation in info box; **notify OTN of the data product (data@oceantrack.org) — user ask** | per-row citation + "Ocean Tracking Network, CC-BY 4.0" | erddap.oceantrack.org info; members.oceantrack.org/data/policies |
| NOAA Coral Reef Watch 5 km | **yes** | freely available, credit CRW | none | "Courtesy NOAA Coral Reef Watch" | coralreefwatch.noaa.gov citation page |
| NOAA OISST v2.1 | **yes** | US-gov, open directory | attribution | "NOAA/NCEI OISST v2.1 (Huang et al. 2020)" | ncei.noaa.gov OISST pages |
| GBIF occurrences | **shipped** (occurrences layer) | per-dataset CC0/CC-BY/CC-BY-NC (terms page 403) | filter `license=CC0_1_0,CC_BY_4_0`; per-record licence label shown verbatim; per-dataset title, publisher and DOI resolved by the pipeline (`datasets` map) and shown in the info box; per-taxon `truncated` flag when the 600 cap bites | per-dataset citation in-app ("<title>, <publisher>, doi:…"); we use the **search API**, not a download, so no download DOI exists — registering a GBIF *derived dataset* DOI is an open follow-up (needs a GBIF account) | search only |
| OBIS | **shipped** (occurrences layer; Happywhale records arrive CC0 via OBIS) | per-dataset CC0/CC-BY/CC-BY-NC | per-dataset filter + attribution | "OBIS (2026) IOC-UNESCO obis.org + dataset" | manual.obis.org/policy |
| GBIF derived-dataset DOI | tool ready (`pipeline/gbif_derived.py`, dry-run verified on the live file: 2,201 records / 12 datasets); **registration waits for a public sourceUrl (hosting)** | n/a | account in `~/.config/gbif/credentials` | DOI into `dataCredits` once minted | gbif.org/derived-dataset |
| Movebank | **v1 shipped** (curated pilot: 3 CC BY studies — Acopian vultures USA, LifeTrack white storks SW Germany, Galápagos tortoises — in `pipeline/tracks.json`; `license_type` read LIVE per run and anything but CC_0/CC_BY is refused) | per-study CC0/CC-BY/CC-BY-NC | account credentials in `~/.config/wildeye/env` (server-side only); licence-md5 handshake handled; 60-day window, 7-day publication lag | study citation in the info box | movebank terms + data-policy |
| Copernicus Marine BGC | deferred (NOAA VIIRS chlorophyll shipped instead, no credentials needed) | free licence, redistribution + derivatives allowed | registration; credentials server-side only | "Generated using E.U. Copernicus Marine Service Information; DOI …" | marine.copernicus.eu licence; help art. 4444611 |
| NASA OB.DAAC / CyAN | yes-cond | CC0 unless marked | Earthdata login server-side | "NASA OB.DAAC (CC0), product DOI" | earthdata data-use-guidance |
| iNaturalist | v2 | default CC-BY-NC per observation; some ARR | filter licence; never de-obscure | "© observers via iNaturalist, licence per record" | help.inaturalist.org |
| Global Fishing Watch | v2 | CC-BY-NC; token; 50k req/day | server-side token | "Powered by Global Fishing Watch" | gfw license-rate-limits |
| eBird API | **undecided** | could not fetch (403/login) | read in a browser before any use | — | — |
| NOAA RWSAS right whales | **undecided** | InPort: "Email point of contact" | ask NEFSC before ingest | — | inport item 23305 |
| Motus | **no (v1)** | no open licence; public = summaries; collaboration policy | needs Birds Canada agreement | — | motus.org/policy PDF |
| USA-NPN phenology | **shipped** (sightings layer, monarch + common milkweed, phenophase_status=1 only) | CC BY 4.0 (quoted 2026-09-11) | citation string per data type; post-publication notice requested | "Data were provided by the USA National Phenology Network and the many participants who contribute to its Nature's Notebook program." | usanpn.org/about/terms |
| iNaturalist via GBIF | **shipped** (already flows through the GBIF per-record CC0/CC-BY filter; dataset 50c9509d appears in the datasets map) | dataset-level CC BY-NC, **per-record CC0 / CC BY** (2026: 1.02 M CC0, 2.38 M CC BY) | existing per-record filter; media excluded; never de-obscure | per record via GBIF dataset 50c9509d + observer | api.gbif.org dataset record |
| eBird EOD via GBIF | v1 **historical only** | CC BY 4.0 at dataset level; temporal coverage ends 2024-12-31 (0 records 2025/2026) | not a live feed | "EOD – eBird Observation Dataset, Cornell Lab, via GBIF" | api.gbif.org dataset 4fa7b334 |
| IOOS ATN telemetry (ERDDAP) | **v1** (Wave 2 lead) | per-dataset; sampled spotted-seal deployment: "may be used and redistributed for free" | verify licence text per dataset before ingest | per-deployment citation + "IOOS Animal Telemetry Network" | atn.ioos.us/erddap info pages |
| NOAA NDVI CDR (NCEI THREDDS WMS) | **shipped** (ndvi layer) | US public domain (NOAA CDR) | cite CDR product page | "NOAA Climate Data Record of NDVI (VIIRS), NCEI" | ncei.noaa.gov CDR product page |
| NOAA CRW DHW / HotSpot / sea ice | **shipped** | US public domain | credit CRW | "Courtesy NOAA Coral Reef Watch" | same ERDDAP dataset as BAA |
| Xeno-canto | **v1 shipped** (adapter in `pipeline/occurrences.py`, group "sounds"; server-side `lic:by` + per-record `licence_ok`; ~240 CC BY uploads per 120 d worldwide, 0 CC0; `since:` is the UPLOAD date so recording dates are re-filtered) | API v3 needs a key (401 without); per-recording CC, SA/NC/ND excluded by policy | key server-side; hotlink audio; attribute recordist | per recording | xeno-canto.org/api/3 |
| NEON | Wave 4 (credentialed) | data API 403 without token (probed 2026-09-11); usage policy CC BY 4.0 except RTE species (per panel; policy page unread by me) | token server-side | NEON citation | data.neonscience.org/api |
| WastewaterSCAN | **no** | CC BY-NC 4.0 + "contact for purposes beyond public-health decisions or research" (quoted 2026-09-11) | — | — | data.wastewaterscan.org/about |
| CDC NWSS (data.cdc.gov **j9g8-acpt**; 2ew6-ywp6 archived 2025-09-12) | **v1 shipped** (polygon contract, county-level) | metadata licence `Public Domain U.S. Government` (USGOV_WORKS); CDC footnote: concentrations not comparable across sites → per-site trend only; WastewaterSCAN-sourced rows excluded (CC BY-NC) | county polygons from Census 2021 boundaries (2022+ vintages drop CT counties) | "CDC National Wastewater Surveillance System" + non-endorsement disclaimer | data.cdc.gov/api/views/j9g8-acpt |
| Allen Coral Atlas | **no (v1)** — permission required | ToU (read 2026-09-11): no automated retrieval ("robot, spider… scrape or index"); no reproduction/distribution "without ASU's prior written consent"; product licences not on ToU/attribution pages | ask support@allencoralatlas.org | — | allencoralatlas.org/tou |
| OBIS-SEAMAP | CC0 datasets only | terms (read 2026-09-11): no redistribution "without consent from OBIS-SEAMAP and the original contributors unless the datasets are explicitly shown under the CC0 sharing policy" | filter to CC0 sharing policy | per dataset + OBIS-SEAMAP citation | seamap.env.duke.edu terms |
| USF Sargassum Watch | **no** | "Any use of the image, data, or graph… should obtain permission from the USF OOL group" (read 2026-09-11) | — | — | optics.marine.usf.edu/projects/saws.html |
| Whale Safe | **no** | no API/download/licence published; contact bosl-whalesafe@ucsb.edu | — | — | whalesafe.com/about |
| Columbia River DART | v1-cond (site series) | no licence text; USACE/PUD/state agency counts, courtesy credit line; CSV query links exist | email web@cbr.washington.edu before redistributing | "Data courtesy of U.S. Army Corps of Engineers, NWD and Chelan, Douglas, and Grant County PUDs…" | cbr.washington.edu/dart |
| USDA APHIS HPAI wild birds | **v1 shipped** (polygon contract: county fill = confirmed detections in the 7-day bin / last 8 weeks; captive wild birds counted separately) | US-gov work, public domain; official CSV behind the page (`/sites/default/files/hpai-wild-birds.csv`, the page's `data-csv-url` — the earlier "no official download" was a missed attribute) | counties matched by (state, county name) to Census 2021; "Unknown" county rows (0.7 %) and dissolved Valdez-Cordova dropped | "USDA APHIS" | aphis.usda.gov HPAI wild birds page |
| PhenoCam | v2-cond (site series) | imagery free with registration; fair-use policy; datasets "preliminary until… ORNL DAAC with a DOI" | use ORNL DAAC releases (DOI) rather than live imagery | PhenoCam Dataset DOI | phenocam.nau.edu/webcam/about |
| Reef Life Survey | could not read | site returns 403 to the fetcher; HTML has no licence string | read in a browser | — | reeflifesurvey.com |
| Kelp Watch | could not read | terms page is a JS app (922 B HTML); panel cites ODbL | read in a browser | — | kelpwatch.org/terms |
| Global Forest Watch | Wave 4 (credentialed) | ToS (globalnaturewatch.org/terms, read 2026-09-11): per-dataset licences in metadata; API key per request; attribution required | check each layer's metadata licence; CC BY layers only | resourcewatch.org attribution requirements | globalnaturewatch.org/terms |
| Happywhale | **no** | CC-NC via OBIS-SEAMAP mirror; own terms unreadable; no API | — | — | seamap partner page |
