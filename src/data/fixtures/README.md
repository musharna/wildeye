# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.
- `gbif-arachnida-recent-3-2-3.mvt` — one real GBIF occurrence vector tile
  (layer `occurrence`, extent 1024, each feature's record count in `total`):
  every CC0 / CC BY record of class Arachnida (taxonKey 367), 2017–2026, z3
  x2 y3 (eastern North America and the western Atlantic), captured 2026-10-01
  from `api.gbif.org/v2/map/occurrence/adhoc/3/2/3.mvt?srs=EPSG:3857&license=CC0_1_0&license=CC_BY_4_0&year=2017,2026&checklistKey=d7dddbf4-2cf0-4f39-9b2a-bb099caae36c&taxonKey=367`
  (9,728 bytes, 388 features, 224,697 records). Used ONLY by
  `src/data/effort.test.mjs` to pin the recording-effort veil offline. Data
  from GBIF.org under CC0 / CC BY.
- `jrc-occurrence-13-6462-3802.png`, `jrc-occurrence-8-103-120.png` — two real
  JRC Global Surface Water occurrence tiles (Tonle Sap at z13, RGBA with
  semi-transparent pixels; open Atlantic at z8, RGB), captured 2026-10-01 from
  `storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png`.
  Source: EC JRC/Google, free of charge, without restriction of use.
- `gibs-evi-2024-06-09-4-4-6.png` — one real NASA GIBS palette tile with tRNS
  (`MODIS_Terra_L3_EVI_16Day`, 2024-06-09, z4 x4 y6; ocean transparent),
  captured 2026-10-01. NASA open data.
- `png-filters-rgba-37x23.png`, `png-filters-rgb-37x23.png`,
  `png-paeth-tie-rgb-2x2.png` — synthetic PNGs written 2026-10-01 by a Python
  encoder, rows cycling through filter types None/Sub/Up/Average/Paeth (the
  2×2 one is a Paeth tie, pa == pc < pb), each checked to decode to its source
  pixels with PIL.
- All PNGs are used ONLY by `src/data/pngDecode.test.mjs`, which pins each to
  the sha256 of PIL's `.convert('RGBA').tobytes()` of the same file.
