# A0: can the radar see waterfowl apart from songbirds? (fast-flier gate)

First gate of question A in the disease program (does bird flu in wild birds follow the radar's migration nights?).
Bird flu (HPAI H5) in wild birds is mostly a waterfowl disease; vol2bird's nightly totals are mostly songbirds. A
needs a waterfowl series, and this check asks whether airspeed gives one. If it does not, A stops in its waterfowl
form (VOID), and the full backfill is not run.

Rules written 2026-11-07 ~22:05 EST (commit cfdb763b1), **before any airspeed was computed on the season store and before any eBird
count was fetched**. Grill ledger: `grill_wildeye_disease_program_2026-11-07.md` (outside the repo); prior-art map:
`triage_wildeye_disease_seam_2026-11-07.md` (outside the repo).

## Prior art for the split

- Ducks, geese and swans are fast fliers, 15–20 m/s; diving ducks exceed 20; songbirds sit in the lower part of
  the 8–23 m/s range (Alerstam et al. 2007, *PLoS Biology* 5: e197, doi:10.1371/journal.pbio.0050197; tracking
  radar, 138 species, equivalent airspeed).
- No source was found that splits vol2bird profiles into waterfowl and songbirds by airspeed (checked: web search
  2026-11-07, one query, extended mode; NEXRAD waterfowl work found uses reflectivity checked against ground
  counts). So the split is this check's own and must be shown to work here; it is not borrowed.
- A vol2bird bin's speed is a mean over every target in it, so a bin reads fast only when fast fliers dominate it.
  The fast series is therefore a floor on waterfowl passage, not a count.

## Rules

- **Data.** The stored 10-minute profiles of all 20 radars (`pipeline/sites.json`), falls 2025 and 2026
  (Aug 1 – Nov 15, `pipeline/bird_seasons.py`), nights as `pipeline/bird_nights.py` defines them. No new radar scans.
  *Clarified 2026-11-08 01:13 EST, before any gate was computed (the only numbers seen are the 3-night pilot's:
  M0 and the Aug 1–3 classes).* Fall 2026 is stored in two places: the season backfill (`vp-season`, Aug 1 – Sep 27)
  and the nightly cron's store (msi-4080 `~/.cache/wildeye/vp`, Sep 27 on). The run reads their union
  (`~/.cache/wildeye/vp-a0`: hard links of the first, then the second pulled with `--ignore-existing`; 0 file names
  in both, 0 profile times in both on the Sep 26–28 nights at all 20 radars, ~73 profiles per radar-night either
  side). The first full run was started on Nov 7 while fall 2026 was still going on; it stopped at an RAP hour not yet
  published (2026-11-08 06 UTC). The binding run waits until the Nov 15 night has ended; `fast_fliers.season_over`
  now refuses any earlier run.
- **Airspeed.** Per bin, as `pipeline/insect_check.py` computes it: |vol2bird (u, v) − RAP wind at the bin's middle
  height|, RAP hour nearest the profile, turned to earth-relative.
- **Classes.** Insect-like < 5 m/s (as `bird-insects.md`); **slow** 5 ≤ a < 12; intermediate 12 ≤ a < 15 (reported,
  not used); **fast** a ≥ 15 (Alerstam's waterfowl range starts at 15). Shares are density-weighted.
- **Fast passage** per night = night total `mt_birds_km` × the night's fast share; slow likewise.

## Gates (all five must pass for FIRED)

- **M0 wind.** The RAP turn error ≤ 0.2° and RAP against radiosondes ≤ 3 m/s RMS over this run's hours (the
  `bird-insects.md` limits).
- **M1 the class exists.** Fast bins hold ≥ 2 % of a radar's season density at ≥ 14 of 20 radars, in each fall.
- **M2 it migrates later.** Waterfowl move later in fall than songbirds. The density-weighted median night of fast
  passage is ≥ 7 days after that of slow passage (7 = the weekly bin of the APHIS analysis) at ≥ 14 of 20 radars,
  in each fall. Positive control in the same gate: the slow class's median night falls between Sep 10 and Oct 20
  (the eastern songbird peak) at ≥ 14 of 20 radars; if it does not, the slow class is not songbirds and M2 fails.
- **M3 a second wind engine.** A fast bin could be a songbird whose wind was misread by 3+ m/s. At every radar with
  an upper-air station ≤ 50 km away (IEM station list, chosen by distance before any profile is read; the
  nearest one that launched that fall, skipping IEM's merged `_XXX` area ids, which its CSV service does not
  serve; every station passed over is listed in the output: clarified 2026-11-07 before any M3 number existed), profiles
  within 30 min of 00Z get their airspeed again from the radiosonde wind (linear in height). Over those nights:
  median Spearman ≥ 0.6 between the RAP and radiosonde nightly fast shares, and the pooled fast share by
  radiosonde within 0.5–2× the RAP one. Deepest shared layer: vol2bird's (u, v), common to both; the error under
  test lives in the wind, which differs.
- **M4 an outside count says it is ducks.** eBird records on GBIF (EOD, CC BY 4.0, dataset
  `4fa7b334-ce0d-4e88-aaae-2e0c138d049e`), within 150 km of each radar, per ISO week from Aug 1 to Nov 15 2025.
  GBIF holds 2025 eBird records through December and none for 2026 yet (checked: GBIF occurrence counts for
  class Aves by month, 2026-11-07: 2025-08 14,987,248, 2025-12 14,338,877, 2026-10 0). Duck-family share = records
  in Anatidae (GBIF family 2986) / records in Aves (class 212). Per radar, Spearman over weeks between the duck share
  and the radar's weekly fast share, with 2025 radar data (same year) and with 2026 radar data aligned by ISO week
  (wrong-year placebo). Passes if the same year beats the wrong year at ≥ 15 of 20 radars (sign test, p ≈ 0.02).
  Both years share the calendar, so only a fast series that follows *this year's* ducks can pass.

## Verdict and what follows

- **FIRED** (M0–M4 all pass): A goes ahead with the fast series as its waterfowl measure; the season window is
  extended to Dec 31 and falls 2022–2024 are backfilled (runtime measured first).
- **VOID** (any gate fails): A does not go ahead in its waterfowl form. The failing gate and its numbers are written
  here. No threshold, class edge, radius or radar set changes after this file is committed.

## Before the real run

- **Planted truth** (unit tests, through the same functions): bins at wind + 18 m/s read fast and wind + 9 m/s read
  slow; a night planted with 30 % fast density reads 0.30 ± 0.01; a night with no fast bins reads exactly 0; a
  heading flip changes nothing.
- **Runtime.** The RAP fetch is timed on 3 nights first; if the projected total is over 2 h, the run is
  restructured before launch.
