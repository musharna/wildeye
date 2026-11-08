# F: can the radar say when birds bring ticks? (feasibility only)

Question F of the disease program: does tick arrival follow radar-measured bird migration? The grill set F as a
written feasibility verdict, not a run. Written 2026-11-08 01:44 EST. Grill ledger:
`grill_wildeye_disease_program_2026-11-07.md` (outside the repo).

## Verdict: not feasible with the data wildeye holds

No outcome in reach measures ticks arriving with birds, and the one tick series wildeye has (NEON) sits near only
6 of the 20 radars. F reopens only if one of the routes under "What would change it" appears.

## Why

- **The outcome counts the wrong ticks.** NEON's tick product (DP1.10093.001, the `nv` layer) counts ticks questing
  on vegetation, per 1000 m² dragged, by life stage. That measures the population already established at a site.
  Birds bring a few ticks each: 3.56% of 3,844 spring migrants from the Neotropics carried ticks on the Gulf coast
  (Cohen et al. 2015, *Applied and Environmental Microbiology* 81:8366–8378, doi:10.1128/AEM.02656-15), and 3.6% of
  5,122 birds over 15 fall and spring seasons in northern Michigan, median one tick per infested bird (Scharf et al.
  2021, *The Great Lakes Entomologist* 53, doi:10.22543/0090-0222.2378). Local larvae dominate drag counts (OSBS,
  August 2026: 5,700 of 5,727 ticks). A season's bird delivery would not show in them; this is reasoned from those
  numbers, not a computed power analysis.
- **Too few sites.** 6 of NEON's 47 sites lie within 150 km of a wildeye radar, and 3 of those share one radar
  (BLAN 49 km, SCBI 58, SERC 80 from KLWX; DSNY 77 from KMLB; OSBS 93 from KJAX; HARV 107 from KBOX; computed from
  `public/data/neon-vectors.geojson` and `pipeline/sites.json`, 2026-11-08). With two falls of radar, that is no
  design. NEON lab counts also lag months (August 2026 still pending at 5 of the 6 on 2026-11-08).
- **No arrivals data.** No open, dated US series of ticks taken from migrating birds was found (checked: GBIF dataset
  search for "ticks on birds", "ticks migratory birds", "ectoparasites birds banding", "Ixodes birds", 2026-11-08:
  the bird-tick series there are from Catalonia and Slovakia; one web search, 2026-11-08: Hungarian and Swedish
  station data, and a 2026 request from UCLA's Center for Tropical Research to banders in the IBP network to collect
  ticks from migrants, which could become one).

**Correction to the grill.** The grill gave as a reason "the archive is fall, tick imports are spring". The second
half is wrong as stated: fall migrants carry ticks too (Scharf et al. 2021 sampled both seasons), and fall dispersal
of *Ixodes scapularis* by ovenbirds and wood thrushes has been modelled (Tonelli & Dearborn 2019, *Ticks and
Tick-borne Diseases* 10:1096–1104, doi:10.1016/j.ttbdis.2019.05.012; abstract not available, cited by title only).
The fall archive is not the blocker; the outcome is. Spring imports of Neotropical ticks (Cohen et al. 2015) remain
outside the archive.

## What would change it

- **Ticks on birds by capture date at banding stations near the radars** (the IBP request above, if its data are
  released). Then: infested birds per capture-day against the radar's passage on the nights before, with the
  wrong-year placebo the program uses, at stations within 150 km of a radar.
- **A spring radar archive**, for the Gulf-coast arrival route Cohen et al. 2015 measured; KTBW, KJAX and KMLB are
  the nearest wildeye radars, but no Texas or Louisiana radar is in the 20.

Citations checked against CrossRef (first author, year, title, volume, pages), 2026-11-08.
