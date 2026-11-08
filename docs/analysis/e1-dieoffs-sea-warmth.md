# E1: do coastal die-offs start in weeks of unusually warm water?

E0b's question with sea-surface temperature in place of drought: do WHISPers die-offs in coastal counties start in
weeks when nearby water is warmer than the same week in the neighbouring years? The disease program grill set marine
heat as E's next extreme after drought (`grill_wildeye_disease_program_2026-11-07.md`, outside the repo).

Rules written 2026-11-08 03:27 EST (this file's first commit), after the SST fetch and **before any WHISPers case,
the murre cases included, was scored against SST**. The planted arms and the murre check are run after this commit,
in the same run as the classes.

## What was seen before these rules (disclosure)

- E0, E0b and E0c in full (all drought): class results on all US counties, not on SST.
- Counts only: confirmed cases in coastal counties per class (Trauma 313, Nut/Met/Dev 254, Virus 300, Fungus 118,
  Other 617, Toxin 286, Bacteria 147, Parasite 81, with a 100 km disc on a one-day ocean mask); common murre events by
  year and class (single-county cases, before the coastal and confirmed filters: 2015 11 Nut/Met/Dev and 1 Other;
  2016 1 Nut/Met/Dev and 2 Other).
- SST itself for the fetch's real-execution check (Pacific 2015: Clatsop, OR, 11.3 °C on 2015-01-16; San Diego
  22.7 °C on 2015-08-16), no case attached.

## Exposure

- **SST**: NOAA OISST v2.1 (0.25°, daily; CoastWatch ERDDAP `ncdcOisst21Agg_LonPM180`, 1981-09-01 to 2026-10-23 when
  fetched). The marine heatwave product wildeye's map uses (CRW `mhw_5km` on PacIOOS ERDDAP) starts 2024-07-01, and
  no ERDDAP holding its history was found (checked: CoastWatch ERDDAP search "heatwave" at coastwatch.noaa.gov and
  coastwatch.pfeg.noaa.gov, 2026-11-08: 404 / no match), so heat is read as rank of SST, not as heatwave category.
- **A county's SST**: mean over OISST cells whose centres lie within 100 km of the WHISPers county centroid, ocean
  and Great Lakes cells only (land is missing in OISST), per day; a week's value is the mean over its ISO week with
  at least 5 of 7 days. A county with no such cell is not coastal and its cases are not in E1.
- Fetched one ERDDAP request per region-year (Pacific, East and Gulf with the Great Lakes, Alaska, Hawaii,
  Caribbean), 1997 to 2026-10-23. A county is read from the first box that holds its whole disc. Left out: Midway
  (74300, across the dateline, 2 cases).

## Score, data, controls

- **Score and stratum**: E0b's rank score, unchanged (`pipeline/e0b_rank.py`), with SST for DSCI: s = mid-rank of the
  case week's SST among the same ISO week of the case's ISO year ± 4, centred (−½ to +½; 0 = no warmer). Drops
  (`no_map` = week with < 5 days, `few_years`, `stratum_flat`) counted and reported.
- **Data**: E0's cases (confirmed, US, single county, 2001–2025, class = major else priority-1 diagnosis type) in
  coastal counties. Suspect-only cases as E0's sensitivity arm.
- **Statistic**: mean s per class, county bootstrap 2,000 draws, seed 20261107, Bonferroni over the k classes with
  ≥ 50 coastal confirmed cases.
- **Planted truth, exact expectation** (gates): each case's expected s with its year drawn from its stratum with
  weight exp(β × SST in °C); β = 0 CI must contain 0, β = 1 per °C CI must be above 0.
- **Known positive, mechanism fired** (gates): the common murre die-off of summer 2015 to spring 2016, which Piatt et
  al. 2020 (*PLoS ONE* 15:e0226087, doi:10.1371/journal.pone.0226087) tie to the 2014–16 northeast Pacific heatwave
  ("temperatures that exceeded average by 2–3 standard deviations"). Cases: confirmed coastal single-county events
  listing Common Murre with start dates 2015-06-01 to 2016-05-31. Their week's SST, in standard deviations above the
  same ISO week in 1997–2012 (≥ 8 years with data), must average ≥ 1. If not, the exposure does not see the best
  documented marine heatwave die-off in the data, and E1 is VOID.
- **Placebo week** (+26 weeks) and **negative-control cause** (Trauma) as E0b.

## Hypotheses (named before the run; not controls)

- Nut/Met/Dev above 0 (starvation die-offs of seabirds, the murre mechanism). Because the murre cases are in this
  class, it is also reported without them; a Nut/Met/Dev finding that disappears without the murres is one event,
  not a pattern.
- Toxin above 0 (algal biotoxins; type E botulism in the Great Lakes). Every other class: no direction stated.
- Note the ±4-year stratum: a multi-year heatwave (2014–16) puts warm years on both sides of a case, which lowers its
  rank. This works against finding an effect, not for it.

## Verdict

- E0b's rule, unchanged, plus the known positive: a class is a **finding** if its CI excludes 0, its placebo CI
  contains 0, Trauma's CI contains 0, and the planted truth passed. **CLOSED** when every tested class has a verdict;
  **VOID** if Trauma, the planted truth or the murre check fails.
- One run. No threshold, radius, window, stratum, class rule or score changes after this file is committed.

## Result

Not run yet.
