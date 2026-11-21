# D: do human West Nile and EEE cases follow radar-measured migration? (feasibility check)

Question D of the disease program: does radar-measured bird passage near each radar predict human West Nile virus
(WNV) or eastern equine encephalitis (EEE) cases there? This check was run on 2026-11-19, before any design, to
learn whether the data can carry the program's test. It counts human cases and lists archive file names only. No
radar profile was opened and nothing was compared with migration, so a later D design stays blind. Grill ledger:
`grill_wildeye_disease_program_2026-11-07.md` (outside the repo).

## Verdict: not feasible as posed; a spring-passage version is feasible on counts

- **As posed** (fall passage from the five stored falls, 2021–2025, against WNV and EEE): not feasible. Five years
  give four wrong years per year where the test needs 19, fall passage comes after most cases, and EEE is too rare.
- **Redesigned** (spring passage, 2003–2025, WNV only, from BirdCast's public archive): the counts allow it. That
  is a new question and needs its own pre-registration; nothing here says it would pass.

## Status: not run; the program closed on 2026-11-20

The spring version was not designed or run. The owner closed the disease program on 2026-11-20 with D at this
feasibility verdict. Where each question ended:

| Question | Ended as | Record |
|---|---|---|
| A0: can radar speed pick out waterfowl | VOID: under 0.3 % of classed passage was fast at every radar | `a0-fast-fliers.md` |
| A: bird flu in wild birds vs. radar passage | VOID: it ran only if A0 fired | `a-hpai-radar.md` |
| B: H5 in wastewater vs. passage | Not feasible | `b-wastewater-feasibility.md` |
| C: passage lead over poultry outbreaks | Not run: it reused A's series | (none) |
| D: human WNV and EEE vs. passage | Not feasible as posed; spring version not run | this file |
| E: wildlife die-offs vs. drought and sea warmth | E0 VOID; E0b one small finding (bacterial die-offs); E0c inconclusive, so the finding is not shown on the site; E1 VOID | `e0-dieoffs-drought.md`, `e0b-dieoffs-drought-rank.md`, `e0c-waterbird-detection.md`, `e1-dieoffs-sea-warmth.md` |
| F: ticks vs. passage | Not feasible | `f-ticks-feasibility.md` |

No result met the program's bar for the site (a result that survives its strongest objection).

## Counts

CDC ArboNET, county of residence × year, 1999–2025: 28,305 county-years, 63,155 human WNV cases (CDC's
month-of-onset file sums to 63,153). A county counts as near a radar when its Census 2021 internal point is within
150 km (the grill's frozen radius); a county near two radars counts for both. Connecticut's nine planning regions,
which CDC has used in place of counties since 2023, are not in the 2021 file and are placed at their Census 2024
internal points.

| Radar | Counties | Cases 1999–2025 | Median a year, 2003–25 | Years with none, 2003–25 |
|---|---:|---:|---:|---:|
| KLOT | 39 | 3,010 | 68 | 0 |
| KDIX | 41 | 1,932 | 53 | 0 |
| KOKX | 41 | 1,628 | 50 | 0 |
| KLWX | 73 | 931 | 22 | 0 |
| KCLE | 38 | 714 | 12 | 2 |
| KFFC | 75 | 407 | 11 | 0 |
| KBOX | 31 | 357 | 10 | 2 |
| KILN | 71 | 426 | 9 | 0 |
| KGRR | 34 | 392 | 7 | 1 |
| KPBZ | 49 | 257 | 5 | 2 |
| KCLX, KAKQ, KJAX, KOHX | 30–75 | 95–158 | 3–4 | 2–5 |
| KRAX, KBUF, KMHX, KLTX, KMLB, KTBW | 14–49 | 29–97 | 1–2 | 6–11 |

- **Radar-years, 2003–2025:** 460; 71 have no case and 217 have fewer than 5. Ten radars have a median of at
  least 5 cases a year, seven of at least 10.
- **Shared swings:** of the year-to-year variance within a radar (log cases), 40 % is a swing shared by all 20
  radars and 60 % is local, small-count noise included.
- **Month of onset, US:** 19 % of WNV cases begin by the end of July, 64 % by the end of August, 93 % by the end
  of September (EEE: 26 %, 67 %, 91 %).
- **EEE, 2003–2024:** 215 US cases in 22 years (1 to 38 a year). 78 of 440 radar-years have any case, and 71 of
  the 174 radar-case counts are near KBOX.
- **Radar archive (file names only):** BirdCast's daily files run from 1995–96 to 2026 for all 20 radars, every
  month. For 2003–2025, 444 of 460 radar-springs have a file on at least 90 % of April–May days (lowest 70 %,
  KDIX 2019); 453 of 460 for August–October, and 453 of 460 for October–November.

Reproduce with `python3 -m analysis.d_arbo_counts --dir <cache dir>`: it downloads the inputs (each CDC and Census
file pinned by sha256) and the archive listing, and prints every number above. Rerun from an empty directory on
2026-11-20, it printed the same case counts as on 2026-11-19, line for line, and the archive shares above.

## Why

- **Five years cannot carry the wrong-year test.** A 95 % rule needs at least 19 wrong years. The stored falls
  give 4. The public outcome is one number per county per year, so A's weekly-timing test has nothing to work on.
- **Fall passage is too late.** Two thirds of cases have begun before September, and the stored fall window runs
  August 1 to December 31. Passage that follows the cases cannot be tested as their cause with yearly counts.
- **EEE is too rare** to test near these radars, and a third of it sits at one radar.
- **Spring passage clears those three.** It comes before the season, the archive holds it, and 2003–2025 gives 22
  wrong years for each year.

## What a spring design must settle before any radar value is read

- **One method across 23 years.** The 2021–2025 census for A found several file layouts (a missing or blank
  height-reference column, a different time format) and scans at KAKQ with a different filter setting. The same
  census is needed for 2003–2020, and it must cover radar hardware upgrades in those years (not checked here).
- **Weather as a common cause.** A warm or dry year can move both migration and mosquitoes. The same year's
  late-fall passage (October–November, after 93 % of onsets) can serve as an exposure that must not predict cases.
- **Which outcome.** Neuroinvasive cases depend less on testing effort (medians a year: KLOT 54, KDIX 43,
  KOKX 41, KLWX 15, KCLE 9, KBOX 8, KFFC 8, KILN 7).
- **Which radars.** Set from these counts alone, before the radar is read.
- **Cost.** About 42,000 daily files for 20 radars × 23 springs, near three times A's fetch (17 minutes). Total
  passage needs no wind data.
- **Odds.** With one case count per county per year, about ten usable radars and weather moving both sides, a
  positive result would still face the common-cause objection. This is why the program closed without running it.

## Limits of this check

- The CDC files are Internet Archive captures (WNV county and month files 2026-07-26, Connecticut 2022 file
  2026-03-21, EEE files 2026-03-20): www.cdc.gov answered 403 to this network. CDC finalized 2025 on 2026-09-16,
  after the capture, so 2025 counts may move; EEE's capture ends at 2024.
- Connecticut is reported by county to 2022 and by planning region from 2023 (placed at 2024 gazetteer points).
  Three "county unknown" codes are not placed.
- Cases are by county of residence, not of exposure.
- The archive listing is live, so file counts for 2026 will grow; the years counted here are closed.
