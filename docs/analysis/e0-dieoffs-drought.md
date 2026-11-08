# E0: do wildlife die-offs follow drought, cause by cause? (case-crossover)

Question E of the disease program. Each published analysis of US wildlife die-offs against the environment covers
one cause in one region; the only national multi-year analysis of WHISPers data found covers one cause
(finch salmonellosis: Tonelli et al. 2026, *PNAS*, doi:10.1073/pnas.2511209123). This check asks, for every
WHISPers cause class at once, whether die-offs start in drier weeks than the same county sees in other years.
E0 is drought only; heat, marine heatwaves and algal blooms need a temperature history wildeye does not hold
yet and are a later E1.

Rules written 2026-11-07 ~22:30 EST, **before any WHISPers event was joined to a drought value**. Grill ledger:
`grill_wildeye_disease_program_2026-11-07.md` (outside the repo); prior-art map:
`triage_wildeye_disease_seam_2026-11-07.md` (outside the repo).

## Data

- **Die-offs.** USGS WHISPers event summaries (public domain, `https://whispers.usgs.gov/api/eventsummaries/`),
  event type Mortality/Morbidity, start date 2001-01-01 to 2025-12-31, US counties. An event listing one county is
  a case in that county; an event listing several counties is counted and reported, not used. Events with no
  start date are counted and dropped.
- **Cause class.** WHISPers' own diagnosis types (Bacteria, Fungus, Nut/Met/Dev, Other, Parasite, Toxin, Virus,
  Trauma; `/api/diagnosistypes/`). An event's class is the type of its major diagnosis (`major` true; if none, its
  priority-1 diagnosis), confirmed diagnoses only (`suspect` false). Suspect-only events are a sensitivity arm.
  A class is tested if it has ≥ 50 cases.
- **Drought.** U.S. Drought Monitor county Drought Severity and Coverage Index (DSCI, 0–500, weekly map,
  `usdmdataservices.unl.edu` `CountyStatistics/GetDSCI`), the map on or before the event's start date.

## Design

- **Time-stratified case-crossover** (from environmental epidemiology). For each case, the referents are the
  same county's DSCI on the same ISO week in each year within ±4 years of the event year (up to 8). Season and
  county cancel by construction; ±4 years limits drift in reporting effort (WHISPers events before 2019 needed
  ≥ 5 animals). Per case: z = (case DSCI − mean of referents) / SD of referents; cases whose referents have SD 0
  are counted and left out.
- **Statistic per class.** Mean z over cases. CI: bootstrap over counties (cases resampled by county), 2,000
  draws, seed 20261107, at the Bonferroni level 1 − 0.05 / k for k tested classes.

## Controls

- **Planted truth** (through the same code, on the real DSCI of the real case counties): synthetic cases drawn
  with probability rising with the county's DSCI z-score are recovered with a CI above 0; synthetic cases drawn
  independently of DSCI give a CI containing 0. Both must hold before the real run counts.
- **Placebo week.** The same statistic with each case moved 26 weeks later (same county, same referent rule).
  A class whose placebo CI also excludes 0 is not drought-specific and is not claimed.
- **Negative-control cause.** Trauma (collisions, gunshot, predation) has no expected tie to drought. If Trauma's
  CI excludes 0, the design is picking up something other than drought (reporting, county mix) and E0 is VOID.

## Hypotheses (named before the run; not controls)

- Toxin (which holds avian botulism) above 0. No paper measuring botulism outbreaks against drought indices was
  found (checked: OpenAlex search "avian botulism type C outbreaks drought water level temperature wetlands",
  2026-11-07), so this is a hypothesis, not a known answer.
- Every other class: no direction stated.

## Verdict

- A class is a **finding** if its Bonferroni CI excludes 0, its placebo CI contains 0, Trauma's CI contains 0, and
  the planted truth passed.
- **CLOSED** when every tested class has a verdict, findings or not. **VOID** if Trauma or the planted truth fails.
- No threshold, window, class rule or referent rule changes after this file is committed.
