# E0b: do wildlife die-offs follow drought, cause by cause? (rank score)

E0 (`e0-dieoffs-drought.md`) asked whether WHISPers die-offs start in drier weeks than the same county sees in
other years, and came back VOID: its score, mean z against the same week ±4 years, read drought where a plant had
none (mean z 0.73, CI 0.30 to 1.35), because on DSCI, mostly 0 with rare spikes, a few calm strata give z in the
hundreds (`analysis/e0_null_bias.py`). E0b asks the same question with a score whose no-effect value does not depend
on the shape of DSCI. Everything else is E0's, unchanged.

Rules written 2026-11-08 01:39 EST (this file's first commit), **before any WHISPers class was scored with the rank
score in this file**. Grill ledger: `grill_wildeye_disease_program_2026-11-07.md` (outside the repo).

## What was seen before these rules (disclosure)

- **E0's full output**, for all 8 classes: real and +26-week mean z with CIs (`e0_dieoffs.json`). That score is
  biased upward, but its numbers carry some information about each class.
- **A rank score for Trauma and Toxin** (an earlier variant, referents only): 0.511 and 0.516 against 0.5, printed by
  the first run of the E0 diagnosis.
- **The planted arms of this design on the real series** (no class labels involved; numbers below). They changed two
  things before freezing: the gating plant became the exact expectation, and strata became keyed by ISO year.
- What protects E0b: the score, stratum, controls and thresholds were chosen from E0's null failure, not from any
  class result, and every threshold, class rule, window, seed and draw count is E0's.

## Score

- **Stratum.** A case's county, the ISO week and weekday of its start date, and each ISO year from the case's ISO
  year − 4 to + 4 for which USDM has a map (the map on or before that date, at most 7 days old; USDM starts in 2000).
  Keyed by ISO year: the calendar year put cases in the turn-of-year week in the wrong slot (found on the planted
  arms before freezing; E0 has the same fault for ~1% of cases, and E0 is VOID anyway).
- **Rank score.** s = (stratum years with lower DSCI + ½ × years with equal DSCI) / (stratum years − 1) − ½, for
  the case's own year. If the case's year were any of the stratum's years at random, s would average exactly 0, for
  any DSCI shape. s runs from −½ (every other stratum year in more drought) to +½ (every other year in less).
- Dropped, counted and reported: a stratum whose years all have the same DSCI (`stratum_flat`, usually all 0), a
  stratum with fewer than 3 years (`few_years`), a case week with no map (`no_map`).
- **Statistic per class.** Mean s over cases; CI by county bootstrap (cases resampled by county), 2,000 draws, seed
  20261107, at the Bonferroni level 1 − 0.05 / k for the k classes with ≥ 50 confirmed cases. As E0.

## Data

E0's, unchanged: WHISPers Mortality/Morbidity events 2001-01-01 to 2025-12-31 whose every state is in the US, one
county per event, class = major (else priority-1) diagnosis type, confirmed only (suspect-only = sensitivity arm);
USDM county DSCI. The cache E0 fetched is reused as is (`~/.cache/wildeye/e0`: 8,072 events, 1,858 counties).

## Controls

- **Planted truth, exact expectation** (gates). Each real case is replaced by the expected s of a year drawn from its
  own stratum with probability proportional to exp(β × DSCI / 100). β = 0 must give a CI containing 0 (with a correct
  mid-rank every case is exactly 0); β = 1 must give a CI above 0. Run on the real series through the same code.
- **One random draw of each plant** is reported beside it and does not gate: a single draw misses 0 by chance 1 time
  in 20 at 95%.
- **Placebo week**: each case moved 26 weeks later, its stratum centred on the moved date's ISO year. A class whose
  placebo CI also excludes 0 is not drought-specific and is not claimed.
- **Negative-control cause**: Trauma. If Trauma's CI excludes 0, E0b is VOID.

Before freezing (real series, no class scored; `pipeline/e0b_rank.py --planted-only`): expected plant β = 0, mean
0.0, CI 0.0 to 0.0, 5,584 cases in 1,680 counties (148 flat strata, 19 with < 3 years); β = 1, 0.2645, CI 0.2599 to
0.2694. One random draw: β = 0, −0.0087 (CI −0.0165 to −0.0010, missing 0); β = 1, 0.2601. Across 40 other seeds
the random β = 0 plant averaged −0.0005 (SD 0.0031 across seeds, t = −1.0): no lean. Unit tests on DSCI drawn from
the real cache's mix (0: 56%, 1–10: 2.4%, 10–50: 4.5%, 50–200: 24%, > 200: 13%) reproduce E0's failure there
(z 0.29, CI 0.11 to 0.48) and the rank score's 0 (0.008, CI −0.010 to 0.025).

## Hypotheses (named before the run; not controls)

- Toxin (which holds avian botulism) above 0, as in E0. Every other class: no direction stated.

## Verdict

- E0's rule, unchanged. A class is a **finding** if its CI excludes 0, its placebo CI contains 0, Trauma's CI
  contains 0, and the planted truth passed. **CLOSED** when every tested class has a verdict, findings or not;
  **VOID** if Trauma or the planted truth fails.
- One run. No threshold, window, stratum, class rule or score changes after this file is committed.

## Result: CLOSED, one finding (run 2026-11-08 01:40 EST)

Run: `python -m pipeline.e0b_rank --cache ~/.cache/wildeye/e0 --out docs/analysis/e0b_dieoffs.json`; figure
`e0b_dieoffs.png` (`e0b_dieoffs_figure.R`). 5,783 confirmed cases; scored 5,584 (148 flat strata, 32 counties USDM
never mapped, 19 strata with < 3 years). k = 8, CIs at 99.375%.

- **Controls passed.** Expected plant β = 0: 0.0 (CI 0.0 to 0.0); β = 1: 0.2645 (0.2599 to 0.2694). Trauma: +0.012
  (−0.017 to +0.045). The random-draw plant read −0.0087 (−0.0165 to −0.0010), as on the pre-freeze run; not gating.
- **Finding: Bacteria**, s = +0.044 (CI +0.011 to +0.081, 474 cases in 309 counties); placebo +0.013 (−0.026 to
  +0.050). Bacterial die-offs start in weeks that rank drier than the same week in the neighbouring years: mean rank
  0.544 where 0.5 is no difference, about a sixth of what the β = 1 plant reads. By major diagnosis the class is
  avian cholera 200 of 483 confirmed events, salmonellosis 136, and 11 smaller diagnoses (composition only; no
  diagnosis was tested on its own).
- **Not findings.** Virus +0.038 (+0.011 to +0.068) and Other +0.023 (+0.001 to +0.044) read above 0, but so do their
  placebos (+0.053, +0.022 to +0.085; +0.030, +0.008 to +0.050). Toxin, the stated hypothesis (botulism): +0.017
  (−0.012 to +0.045), not supported. Fungus +0.004, Nut/Met/Dev +0.016, Parasite −0.001: CIs contain 0.
- **Suspect-only arm** (sensitivity, no class has ≥ 76 cases except Toxin, Trauma, Virus): Bacteria +0.066 (−0.023
  to +0.159), same sign, CI through 0.

**Limits, and the strongest stand-in objection.**

- The effect is small, and its lower bound (+0.011) is near 0. It is one run of one frozen rule over 8 classes.
- *Detection, not disease* (Schwartz-style: who reports): in dry weeks birds crowd onto fewer wetlands, so a die-off
  may be easier to find and report, not more likely to happen. Trauma, which shares the reporting chain and did not
  move, argues against a general reporting effect but not against one specific to waterbird gatherings. E0b cannot
  separate the two.
- The +26-week placebo is not a clean null for slow drought: a drought spell can last past 26 weeks, so a real
  effect can show in the placebo too. That is a reason Virus and Other might be real; under the frozen rule they are
  not claimed.
- Multi-county events (478) are left out, as in E0.

Not for the site yet: the program's bar is a result that survives its stand-in critic, and the detection objection
above is open.
