# Malaria (P. falciparum in children) from the Malaria Atlas Project (2026-10-03)

Wave 2, PR 2 (grill `grill_wildeye_wave2_2026-10-03`). The site's first live-WMS layer: tiles and point values come
straight from MAP's GeoServer at the year on the time bar; nothing is re-hosted.

## Outcome

- **Malaria: P. falciparum in children (MAP, 2000–2025)** (`malaria`, token `ml`): MAP layer
  `Malaria:202608_Global_Pf_Parasite_Rate` (2026-08 release; PfPR2–10, the share of children aged 2–10 with detectable
  P. falciparum, modelled yearly at 5 km), MAP's default style `Global_Pf_Parasite_Rate_Batlow_masked`.
- On the time bar: 2000-01-01 to 2025-12-31. The drape shows the year at or before the bar's instant; live shows 2025;
  scrubbing redraws at that year (WMS `TIME=<year>-01-01T00:00:00.000Z`, exactly as the capabilities list it).
- A click asks MAP for the cell (GetFeatureInfo, JSON) and reads its rate and 95% interval:
  `26.1% of children aged 2–10 carry P. falciparum (95% interval 3.2% to 68.7%)` · 2025. MAP's no-estimate code
  (−9999, outside the mapped countries) reads no data; a cell MAP masks as sparsely populated (its mask band = 1,
  drawn grey) says so instead of quoting the masked estimate; a rate under 0.1% reads `< 0.1%`, not `0.0%`. Any other
  answer is an error, never "no malaria".
- Legend: the style's six stops (0–100%), the sparsely-populated grey and a caption.

## What the live source showed (2026-10-03)

- WMS 1.3.0 with EPSG:4326 orders the bbox lat,lon: a probe written lon,lat read 10°N 0°E for a point meant as 0°N
  10°E. The readout uses WMS 1.1.1 (lon,lat), and a unit test checks the bbox centre is (lon, lat).
- GetFeatureInfo agrees exactly with a WCS GetCoverage GeoTIFF of the same cell decoded with rasterio (a different
  service operation) at all six known-answer cells. Known answers use 1/24° cell centres (10.0° is a cell edge).
- The style has a drawn FeatureTypeStyle (`mapOnly`) and a legend-graphic one (`legendOnly`) with the same colours.
- Under 19 concurrent requests the server answered every one 200 with `access-control-allow-origin: *`.

## Licence and credit

malariaatlas.org/open-access-policy (read live 2026-10-03): "Our maps are available to all users under the “Creative
Commons Attribution 3.0 Unported License” … We ask that any use of these maps provides the correct citation." MAP's own
data platform cites each layer from its WMS `Attribution` element; the 202608 layers carry none (global and
Malaria-workspace capabilities, CSW record empty). The credit therefore names the Malaria Atlas Project and the
2026-08 release with links to the data platform and the licence, rather than a guessed method paper.

## Acceptance

- `npm test` exit 0, with `malaria.test.mjs` (10 tests on verbatim GetFeatureInfo answers) and the registry pin seen
  to fail first (count 51 vs 52).
- `node scripts/qa-malaria.mjs` exit 0 against a local build: the live capabilities still list the pinned 26 years
  and style, the drawn colour map equals the legend, tiles at 2025 and at a scrubbed 2012 are requested in the release's
  layer and style and answer 200 PNG, and six readouts match the WCS-decoded cells (N Ghana 2025 and 2015, Malawi
  2010, Paris no estimate, an Amazon masked cell, Manaus `< 0.1%`), with no failed MAP requests.
- Mutants via `mutate-run`: the module's request, decoding, year and extent logic against the unit tests; registration
  and time-bar wiring against the QA checks that name them.

## Constraints

No change to other layers. No re-hosting, so the Pages budget is unchanged. Out of scope: incidence and mortality
layers, P. vivax, the confidence-class layer. When MAP publishes a newer release, the pinned layer name and years are
bumped by hand; `qa-malaria.mjs` fails on a mismatch.
