# E0c: is E0b's Bacteria finding a detection effect?

E0b (`e0b-dieoffs-drought-rank.md`) found that bacterial die-offs start in weeks that rank drier than the same week in
the neighbouring years: s = +0.044 (CI +0.011 to +0.081). Its open objection: in dry weeks waterbirds crowd onto
fewer wetlands, so a die-off there is easier to find and report, not more likely. If that is so, the same lean should
show for a waterbird die-off cause drought does not make more likely. E0c tests that, with E0b's frozen score.

Rules written 2026-11-08 01:53 EST (this file's first commit), **before any real date of any E0c arm was scored**.
Grill ledger: `grill_wildeye_disease_program_2026-11-07.md` (outside the repo).

## What was seen before these rules (disclosure)

- Everything E0b disclosed, and E0b's result: the Bacteria finding, and Trauma over all species +0.012 (−0.017 to
  +0.045).
- Case counts per class × bird group (no scores): confirmed waterbird Trauma 175, waterbird Bacteria 237, other-bird
  Bacteria 154.
- The planted arms and the width check below, on the gate arm only (no real date used). They changed one thing: the
  gate's level, from 98.3% (3 arms) to 95%.

## Arms

- **Waterbird**: an event whose every listed species is a bird (Aves) in Anseriformes, Charadriiformes,
  Ciconiiformes, Gaviiformes, Gruiformes, Pelecaniformes, Phoenicopteriformes, Podicipediformes or Suliformes.
  **Other bird**: every species a bird, none in those orders (pelagic orders count here: inland drought cannot crowd
  them). Events with no species, any non-bird, or both kinds of bird are left out of every arm.
- **Gate: waterbird Trauma** (E0's class rule: major, else priority-1 diagnosis type; confirmed only). Trauma shares the
  reporting chain and, in waterbirds, the wetlands, but drought gives no reason to expect more of it.
- **Descriptive: Bacteria split** into waterbird and other-bird events. Not gating; no direction stated.
- Data, score, stratum, drops, placebo (+26 weeks), bootstrap (county, 2,000 draws, seed 20261107): E0b's, unchanged
  (`pipeline/e0c_waterbird.py` calls `pipeline/e0b_rank.py`).
- Levels: the gate is the one test, 95%; the two Bacteria halves 97.5% (corrected for each other).

## Controls

- **Planted truth, exact expectation, on the gate arm** (gates, as E0b): β = 0 CI contains 0, β = 1 CI above 0.
  Pre-freeze: β = 0 0.0 (0.0 to 0.0), β = 1 0.279 (0.263 to 0.295), 168 cases in 148 counties (4 flat strata, 2 with
  < 3 years).
- **Width check** (reported, not gating): the random-draw β = 0 plant on the gate arm over 40 seeds. At 98.3% its CI
  upper bound fell below +0.044 in 15 of 40 seeds (median +0.050); at 95%, 22 of 40 (median +0.041), mean of means
  −0.001. So even with no detection effect at all, this gate rules out one the finding's size only about half the
  time. **Inconclusive is a likely outcome, and leaves the objection open.** 168 cases is what the data hold.

## Verdict (gate arm, real dates)

- **VOID** if the planted truth fails or the gate has < 50 scored cases.
- **Detection supported**: CI lower bound > 0. The Bacteria finding stays off the site.
- **Detection of the finding's size ruled out**: CI contains 0 and its upper bound < +0.044 (E0b's Bacteria mean,
  exact value in the code). The objection is answered for the site's bar.
- **Inconclusive**: otherwise. The objection stays open.
- The gate's placebo is reported; it does not change the reading. One run; nothing changes after this commit.

## Result: CLOSED, inconclusive (run 2026-11-08 01:55 EST)

Run: `python -m pipeline.e0c_waterbird --cache ~/.cache/wildeye/e0 --out docs/analysis/e0c_waterbird.json`; figure
`e0c_waterbird.png` (`e0c_waterbird_figure.R`).

- **Planted truth passed** (as pre-freeze): β = 0 0.0 (0.0 to 0.0), β = 1 0.279 (0.263 to 0.295).
- **Gate, waterbird Trauma: s = +0.003 (CI −0.039 to +0.047), 168 cases in 148 counties.** The CI contains 0 but its
  upper bound is above +0.044 by 0.003, so a detection effect the finding's size is not ruled out: **inconclusive**,
  and E0b's detection objection stays open. Placebo +0.035 (−0.010 to +0.083).
- **Descriptive, Bacteria split** (97.5%): waterbird events +0.074 (+0.031 to +0.116, 233 cases in 136 counties;
  placebo +0.027, −0.022 to +0.074); other-bird events +0.028 (−0.022 to +0.078, 151 cases; placebo −0.004). E0b's
  lean sits in waterbird events.

**What this does and does not say.**

- Waterbird Trauma's point estimate is near 0 while waterbird Bacteria's is +0.074. Read against that number, rather
  than the frozen +0.044, the gate's upper bound (+0.047) would exclude a detection effect large enough to explain the
  waterbird Bacteria lean. That comparison was not the frozen rule and is not claimed.
- The lean sitting in waterbird events fits both stories: crowding onto fewer wetlands raises avian cholera
  transmission and raises the chance a die-off is found. Only the gate separates them, and at 168 cases it could not.
- Nothing more can be done with WHISPers Trauma in waterbirds: these are all the confirmed single-county US cases
  2001–2025. A sharper test needs an outcome with known effort (e.g. refuge mortality surveys that walk the same
  wetlands every week), not more of this series.

Not for the site: the Bacteria finding still does not survive its stand-in critic.
