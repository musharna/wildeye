# Are a radar's big nights insects? (airspeed check)

Weather radar sees insects as well as birds. Birds fly through the air at roughly 8-15 m/s; most insects drift
with the wind. So the speed of the echo *through the air* (ground velocity from vol2bird minus the wind) separates
them. This check asks whether the spike nights at KFFC and KOHX in mid-October 2026 are insects.
Grill ledger: `~/.claude/projects/-home-mjarnold/memory/grill_wildeye_insects_2026-10-20.md` (closed 2026-10-21).

## Rules

Written 2026-10-21 20:46 EDT, before any bird airspeed was computed. Before that, two RAP hours (2026-10-17 00Z and
12Z) were fetched to check the file layout and the wind turn against radiosondes; no profile was touched.

- **Wind.** NOAA RAP hourly analysis (`noaa-rap-pds`, `awp130pgrbf00`, 13 km), geopotential height and u/v on
  1000-600 hPa, at the grid point nearest the radar, linear in height. Each profile takes the analysis hour nearest
  its time. RAP's u/v are relative to its Lambert grid; they are turned to north (`to_earth`).
- **Airspeed.** Per height bin with density > 0 and a velocity: |(u, v) - wind at the bin's middle height|.
- **Cutoff.** A bin is insect-like below **5 m/s** (Shi et al. 2025, *Ornithological Applications* 127: duaf020,
  doi:10.1093/ornithapp/duaf020, on vol2bird profiles; Horton et al. 2016, *Biology Letters* 12: 20160591, use 5.5).
  5.5 and 7 m/s (Cabrera-Cruz et al. 2013, *Condor* 115: 263, best cutoff 5.5-9 m/s in the tropics) are reported, not
  used.
- **Night verdict** (this check's own rule, not the papers'): **insects** when ≥ 50 % of the night's density
  (all bins of all profiles, sunset to sunrise, weighted by density) is insect-like; otherwise **birds**.
- **The wind did something.** A night is **void** when no profile found a wind, or the density-weighted mean of
  |airspeed - ground speed| is under 0.5 m/s.
- **The turn is right.** At every radar the turned grid x axis must match the grid's own drawn x axis within 0.2°
  (exact geometry); otherwise the run stops. (Planned first as "RAP turned beats RAP unturned against radiosondes";
  the two RAP hours above showed RAP-vs-radiosonde scatter of 1-5 m/s per level, larger than the turn itself,
  0.7-1.7 m/s, so that comparison cannot decide it.)
- **The wind is close to the real wind.** RAP vs radiosondes at 925, 850 and 700 hPa, 00Z and 12Z, at radars with a
  sounding site next to them: RMS vector error ≤ 3 m/s over ≥ 30 levels, else every verdict is void.
- **Controls.** KBUF 2026-10-16 and KBOX 2026-10-17 (cold, northern) must read *birds*, or the rule is broken. At
  least one of all 20 radars' nights from 27 Sep to 20 Oct must read *insects*; if none does, the rule has never been
  seen to catch insects and the popup says *unclear* instead of *birds*.
- **Nights asked about.** KFFC 10-11, 10-12, 10-16, 10-17; KOHX 10-16. The popup gets a line for these and for every
  other night that reads *insects*. Counts are never removed.
