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

## Result

Not run yet.
