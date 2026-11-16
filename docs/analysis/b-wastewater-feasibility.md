# B: does H5 in wastewater follow radar-measured migration? (feasibility check)

Question B of the disease program: does avian influenza H5 in municipal wastewater follow radar-measured bird
migration near each radar? The grill placed B after A and C, on the radar backfill of falls 2022–2026. This check was
run early, on 2026-11-08 20:24 EST, to learn whether that backfill would be worth anything to B. It counts wastewater
samples and detections only. No radar data was read and nothing was compared with migration, so a later B design
stays blind. Grill ledger: `grill_wildeye_disease_program_2026-11-07.md` (outside the repo).

## Verdict: not feasible with the 20 radars and the record as it stands

Near the radars there are three falls of H5 wastewater data, and 65 detections in them, a third of them at one site.
The program's test needs many more seasons than that. And where H5 in wastewater has been tied to wild birds
(Oregon), wildeye has no radar.

## Counts

CDC NWSS H5 wastewater (data.cdc.gov `mtpu-urpp`, fetched 2026-11-08, samples to 2026-11-03): 128,361 samples from
965 sites, 3,081 detections. A site counts as near a radar when any county it serves has its Census 2021 internal
point within 150 km of the radar (the grill's frozen radius); 324 sites qualify, and 3 sites name no county the
gazetteer has. Fall = Aug 1 – Dec 31, the backfill window. Sources the site's license policy allows (CDC_Verily,
State_Territory; WastewaterSCAN is CC BY-NC and excluded, as in `pipeline/wastewater.py`):

| Fall | Sites sampled | Samples | Detections | Detecting sites | Weeks with a detection |
|------|--------------:|--------:|-----------:|----------------:|-----------------------:|
| 2022 | 0 | 0 | 0 | 0 | 0 |
| 2023 | 10 | 10 | 0 | 0 | 0 |
| 2024 | 113 | 1,927 | 2 | 2 | 2 |
| 2025 | 214 | 3,674 | 45 | 9 | 19 |
| 2026 (to Nov 3) | 144 | 1,738 | 18 | 10 | 11 |

Including WastewaterSCAN changes little: 5, 48 and 18 detections in falls 2024–2026. 12 of the 20 radars have no
allowed-source detection in any fall (10 with WastewaterSCAN). Reproduce with
`python3 analysis/b_wastewater_counts.py --cache <dir>`.

## Why

- **Too few seasons for the program's test.** The shared kill test compares same-year passage against wrong-year
  passage, and a 95% rule needs at least 19 wrong years per season. Near the radars, wastewater data starts in fall
  2024, so even the full backfill gives three falls (2024, 2025, 2026) and two wrong years for each.
- **The detections near the radars are one site, mostly.** 33 of fall 2025's 45 came from one sewershed, site 1224,
  serving Essex and Union counties, NJ, which tested positive in samples from Aug 12 to Dec 30, 2025. A source that
  is steady from mid-August, before most waterfowl move, does not look like migration. Its source is not known here.
  Without it, the three falls hold 32 detections.
- **H5 in wastewater tracks other animals at most sites.** Across WastewaterSCAN's 40 states, site-level H5 rose
  with local poultry outbreaks and dairy industry, and showed no relationship, or a negative one, with wild-bird H5
  detections (Wolfe et al. 2025, medRxiv, doi:10.1101/2025.05.06.25327100, preprint). Nationally, fall 2024's
  detections were 589 of 703 in California, during its dairy outbreak (allowed sources, by county FIPS).
- **Where wild birds are the likely source, there is no radar.** In Oregon, H5 was detected most often in two
  communities with important wild-bird habitat, and no association was found with poultry outbreaks or dairy
  (Falender et al. 2025, *MMWR* 74:102–106, doi:10.15585/mmwr.mm7406a5). Oregon has the most fall detections in
  2025 (73 of 124) and 2026 (103 of 127). All 20 wildeye radars lie east of 88.1° W.

## What would change it

- **Western radars.** Adding Oregon and Washington radars (Portland is KRTX) to the archive would put radars over
  the sites where wild birds are the likely source. Then B is a new question with its own pre-registration.
- **A placebo that needs fewer years.** Shifting each season's passage series by whole weeks within the season
  gives more placebos than wrong years do, but neighboring weeks are correlated, so it is a weaker test. The grill
  did not adopt it; using it would be a change to the program, made before any radar data is read.
- **Time.** The record near the eastern radars gains one fall a year.

Citations checked against CrossRef (first author, year, title) and OpenAlex abstracts, 2026-11-08.
