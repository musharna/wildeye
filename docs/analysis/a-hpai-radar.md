# A: does bird flu in wild birds follow this year's migration nights?

Question A of the disease program. Bird flu (HPAI H5) detections in sick and dead wild birds rise in fall, and so
does migration, so a match between them proves nothing on its own: the calendar explains both. The test here is
narrower. Same-year radar passage has to predict *when within the fall* detections occur better than the same
radar's passage from a different year, aligned by date. Only the year-specific timing of migration can do that.

Rules written 2026-11-09 EST, **before A0's verdict, before any fast-flier series exists, and before any radar
series has been set beside any APHIS count**. The only APHIS numbers seen are the outcome-only counts below
(`analysis/a_aphis_counts.py`, no radar read). Grill ledger: `grill_wildeye_disease_program_2026-11-07.md`
(outside the repo). A runs only if A0 (`docs/analysis/a0-fast-fliers.md`, PR #169) is FIRED; otherwise A is VOID in
its waterfowl form and none of this runs.

## Outcome (APHIS wild-bird detections, counted 2026-11-09)

- **Source.** The APHIS wild-bird CSV (`pipeline/hpai.fetch_csv`), 20,739 rows on 2026-11-09, newest collection
  date 2026-11-17 (a date in the future: rows collected after the run date are dropped and counted).
- **Kept.** Free-living birds (WOAH class not captive), sampling method Morbidity/Mortality, by **collection date**
  (274 rows have none and are dropped, 1.3 %), county matched by name as `pipeline/hpai.py` does (88 unplaced) and
  placed at its Census 2021 gazetteer internal point, within 150 km of the radar. A county near two radars counts
  for both.
- **Unit: county-weeks.** n(r, y, w) = the number of distinct counties near radar r with ≥ 1 such detection
  collected in 7-day bin w of fall y (bin 0 = Aug 1–7, bin 21 = Dec 26–31, 6 days). One die-off yields dozens of
  birds in the same week (KDIX fall 2024: 26 detections, 3 county-weeks), so counting birds would weight a single
  event like a season.
- **Outcome falls 2022–2025.** Fall 2021 has no Morbidity/Mortality detection near any radar (the CSV's first
  collections, 2021-12-30, are hunter-harvested birds in Colleton SC and Hyde NC), and fall 2026 is not over.
- **Included radar-falls.** ≥ 3 bins with a county-week (set from outcome counts only): 47 radar-falls:

  | Fall | Radar-falls | County-weeks |
  |---|---|---|
  | 2022 | 18 (all but KLTX, KILN) | 270 |
  | 2023 | 6 (KBOX KLWX KCLX KMLB KCLE KFFC) | 51 |
  | 2024 | 8 (KMHX KJAX KMLB KCLE KPBZ KLOT KGRR KOHX) | 71 |
  | 2025 | 15 (all but KMHX KLTX KCLX KJAX KOHX) | 168 |

  County-weeks are summed over all radars, so a county near two radars counts twice. Pooled by bin they run
  7, 7, 7, 15, 25, 24, 20, 20, 39, 24, 24, 26, 29, 37, 19, 14, 23, 27, 30, 56, 47, 40, spread across the
  whole window. KLTX is in no included fall and is not backfilled.

## Exposure (radar)

- **Fast passage** per night, as A0 defines it: night total `mt_birds_km` × the night's fast share (airspeed
  ≥ 15 m/s against RAP wind).
- **Weekly exposure** x(r, Y, w) = log(mean nightly fast passage over the stored nights of bins w−1 and w, + c),
  with c = 1 % of that radar-fall's mean nightly fast passage. Bin 0 uses its own nights. The two-week window covers
  arrival, infection and death without choosing a single lag. NA if fewer than 7 nights are stored (bin 0: 4).
- **Passage falls 2021–2025**, Aug 1 – Dec 31. Fall 2021 enters as passage only (see the placebo).

## The test

- **Year maps.** A map π assigns each outcome fall (2022–2025) a passage fall from 2021–2025, one-to-one: 5 × 4 × 3 × 2
  = **120 maps**. The identity (each fall gets its own year) is the real pairing; the other 119 are wrong-year
  placebos. All radars use the same π, so weather shared across the eastern US stays in the null.
- **Why fall 2021.** With falls 2022–2025 only, there are 24 maps and the smallest possible p is 1/24 = 0.042, so a
  95 % rule could barely be met (B found the same limit with 2 wrong years: `b-wastewater-feasibility.md`). Adding
  one passage-only fall gives 120 maps, smallest p = 1/120.
- **Model**, per map. Within each included radar-fall, its county-weeks are spread over the bins as a multinomial,
  conditional on that radar-fall's total. The total absorbs the year's outbreak size and the counties' effort.
  p(r, y, w) ∝ exp(s_w + β · x(r, π(y), w)). The **calendar arm** is the same model with β = 0. Both arms
  get the same penalty on the week effects, s_w ~ N(0, 2²); β is unpenalized. Bins where x is NA are dropped
  from that radar-fall in both arms.
- **Held out.** Leave one fall out: fit both arms on the other three outcome falls, score the log-likelihood of
  the held-out fall's radar-falls. G_π = Σ over the 4 held-out falls of [ℓ(passage) − ℓ(calendar)]; 2G_π is the
  held-out deviance cut.
- **p = #{π : G_π ≥ G_identity} / 120** (the identity counts itself).

## Verdict

- **PASS**: p ≤ 0.05, G_identity > 0 (same-year passage beats the calendar alone on held-out falls), and β fitted
  on all four falls under the identity > 0 (more passage, more detections; the direction is fixed here).
- **FAIL**: the gates below pass and PASS does not hold. A failure is written up as is. If gate P1's power is
  below 0.5, the write-up says the test could not see an effect of β = 1, not that there is none.
- **VOID**: A0 is not FIRED, or a gate below fails.
- One run. No radius, bin, window, inclusion rule, transform or penalty changes after this file is committed.

## Gates

Run on the real exposure series with planted outcomes (each radar-fall's real total, timing drawn from the model),
before any real outcome is set beside any radar series. 200 seeds each, through the same functions as the real run.

- **P0 null.** Outcomes drawn with β = 0 (calendar shape fitted on the real outcomes, which are radar-free): the share of
  seeds with p ≤ 0.05 must be ≤ 0.08 (5 % plus two binomial SEs at 200 seeds).
- **P1 planted effect.** Outcomes drawn with β = 1 from same-year exposure: the median fitted β is within 0.75–1.25,
  and the share of seeds that PASS is the reported power.
- **P2 wrong year.** Outcomes drawn with β = 1 from fall 2021 exposure for every outcome fall: the identity must
  not win, so the share of seeds with p ≤ 0.05 is ≤ 0.08. This shows the test credits the right year, not the shape
  every fall shares.
- **P3 plumbing (real outcomes, no radar).** The calendar arm beats a uniform spread over the bins on held-out
  falls. If it does not, the outcome dates are being read wrong.

## Reported, never chosen

75 km and 300 km radius; total passage instead of fast; bird detections instead of county-weeks; waterfowl-only
detections (species name contains duck, goose, swan, teal, wigeon, mallard, pintail, gadwall, shoveler, scaup,
merganser, brant, canvasback, redhead, bufflehead, goldeneye, eider, scoter or whistling); hunter-harvest detections.
Hunter harvest follows hunting seasons. The ledger asked for hunting-season dates as a covariate; here the shared week
effects stand in for them, and the result is secondary only. **Fall 2026 replication**, once its Dec 31 night is
over and APHIS has had 3 weeks to report: the 2026 fall is scored with the model fitted on 2022–2025 under its own
year and under each of the 5 wrong years; its rank among the 6 is reported, descriptive only.

## Changes from the grill ledger

- Passage falls 2021–2025 instead of 2022–2026: the placebo needs a fifth passage fall (above), and fall 2026 is
  not complete.
- County-weeks, not detections, for the reason given.
- The ledger's county effects become the radar-fall totals the multinomial conditions on; the outcome is summed
  over each radar's counties.
- Week effects are shared by all radars, which span 27°–43° N. Migration timing differs north to south, but the
  difference is identical under every map.

## Backfill and runtime

- **Needed:** 19 radars (not KLTX), falls 2021–2024 Aug 1 – Dec 31 (4 × 153 = 612 nights per radar) and fall 2025 Nov 16 –
  Dec 31 (46 nights; A0's store ends Nov 15). Fall 2026 Nov 16 – Dec 31 is needed for the replication only.
  NEXRAD Level II and RAP analysis files for 2021 are on S3 (checked 2026-11-09: KDIX 2021-09-15 and 2021-12-15
  volumes listed, `rap.20210915/rap.t03z.awp130pgrbf00.grib2`); the pilot checks the rest.
- **Not yet measured.** The bird-season ledger estimated one Aug 1 – Nov 15 fall at 1–1.5 gt76-days (memory,
  unverified). The need is about 6 such falls, so roughly 6–9 days. Before launch: pilot the production backfill on
  1 radar × 7 nights of fall 2021 and project. If the projection is over 2 h, restructure first. Candidates: 30-minute
  cadence (passage is weekly here), fewer radars by inclusion count, a cheaper wind source for the split. Record a
  separately prompted fresh-eyes verdict on whether a structurally better route exists. A run of more than an hour on
  gt76 needs the user's start time.

## Amendment 1 (2026-11-10 EST): passage source

Written before A0's verdict, before any fast share is computed from the new source, and before any outcome is set
beside any radar series.

- **Pilot.** `bird_nights backfill --workers 16 --every-min 10` on gt76, KDIX × 7 nights of fall 2021 (Aug 1 to
  Dec 23, every 24 days): 532 volumes in 311 s, 0.585 s per volume, 59–89 volumes a night. Projection: about
  960,000 volumes, about 156 h. RAP for every needed hour (9,953): 0.25 s per file, about 0.7 h. Over 2 h, so the
  rule above applies.
- **Fresh-eyes verdict** (a separately prompted agent): do not re-run vol2bird. BirdCast publishes per-scan vol2bird
  profiles, `birdcastdata.s3.amazonaws.com/nexrad/daily/{radar}/{year}/{radar}_vpts_{yyyymmdd}.csv` (u, v, dens,
  eta and gate counts in 100 m bins from 0 to 4,900 m, with the source volume's name). Checked from the bucket
  listing on 2026-11-10: every one of the 19 radars has 143–153 of 153 days from Aug 1 to Dec 31 in each fall
  2021–2025, and all 46 days from Nov 16 to Dec 31, 2025. Files run to 2026-11-09. The vol2bird version and
  settings BirdCast used are not stated, and its 100 m bins differ from the pinned image's 200 m.
- **Layout census** (2026-11-10). The header and first row of every file needed, 16,549 radar-days from Aug 1 to
  Jan 1, 2021–2026; 115 days have no file. Every file was written in 2026, and all share 100 m bins.
  - Heights: `height_reference` is "sea" in most files, blank in every fall-2023 file, and absent (26 columns) in
    31 days of fall 2024 and every Jan 1, 2026.
  - Times: fall-2025 files print milliseconds (`00:02:25.000Z`).

  Sampled on Oct 15 across 19 radars × 2021–2026, plus Oct 15, 2022 on KAKQ: rcs is 11 everywhere and the sd_vvp
  threshold is 1, except 4 of 169 KAKQ scans on Oct 15, 2022, all by day, at 2. For the blank and absent labels:
  on KPBZ, KCLE and KTBW in 2022–2024, the lowest bin with any gates is the one holding the antenna every year
  (400, 200 and 0 m), so the heights are above sea level.
- **Change.** Every passage fall, 2021–2025, and the 2026 replication, comes from BirdCast, fall 2025 included, so
  all years share one method. A0's store is not used for A's exposure.
  - A scan is used only if its heights are labeled "sea", blank or absent, and no bin below the one holding the
    antenna has gates. A file that breaks this stops its radar-fall.
  - A scan whose sd_vvp threshold is not 1 is dropped. The night's count of these goes in the manifest.
  - From each night the first `_V06` scan of each 10-minute slot from sunset is kept, as the backfill does.

  Each kept scan is written in vol2bird's own text layout
  (time to the minute, as vol2bird prints it) and goes through the same `night_total` and fast-share functions as
  A0. Fast passage, the weekly exposure and everything under The test are unchanged.
- **Bridge, run after A0's verdict.** On Aug 1 – Nov 15, 2025, radar-nights present in both BirdCast and A0's
  pinned store, per radar the Spearman correlation between the two sources' nightly values:
  - **B1**: median over radars ≥ 0.9 for night total `mt_birds_km`.
  - **B2**: median over radars ≥ 0.8 for nightly fast passage, and at least 0.2 above the same median with A0's
    fall-2026 store set against BirdCast 2025 by date (a wrong year, which shares only the season's shape).

  Only Spearman correlations are gated, because a constant factor between sources does not change the test. Within
  a radar-fall, a constant added to x cancels in the multinomial.
- **If the bridge fails,** A does not run on BirdCast. It falls back to the pinned image at a 30-minute cadence for
  every passage fall, with A0's fall-2025 store thinned to the same cadence. On fall 2025, 30 minutes against
  10 minutes moved the 14-night mean night total by a median of 2.4 % (90th percentile 5.9 %, at most 8.3 %).
  That run takes about 52 h on gt76 and needs the user's start time.

## Site

Only a PASS ships, as a line in the radar popup. Everything else stays here.
