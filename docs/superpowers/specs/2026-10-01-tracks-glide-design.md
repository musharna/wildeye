# Tracks glide between fixes — design (2026-10-01)

Step 4 of the bio-interpolation wave (grill: `grill_wildeye_bio_interpolation_2026-09-29`, S2, A10, Q8, Q12 and
A1–A5 of step 4).

## Outcome

Switch on Animal tracks, pick a time on the time bar and press play. Each animal whose track covers the moment
moves smoothly along its own fixes, its line growing behind it, instead of jumping once a second. Paused or
scrubbed, the layer draws what it draws today. A track never glides across a gap: not across more than 24 h
between fixes (as today), and, for seals and whales & dolphins, not across land.

## Land

Measured 2026-10-01 against Natural Earth 10 m land: the straight step between two consecutive at-sea fixes
crosses land in 86 of 21,182 seal steps (0.41%, 44 segments) and 89 of 3,582 whale and dolphin steps (2.48%,
17 segments). Reptiles are Galápagos giant tortoises (land), with no at-sea steps.

- Q12 (user `ok`): such a step splits the segment, like a time gap: no line and no glide over land; the track
  shows a break there. Rejected: keeping and labelling the step; routing round land (a path the tag never
  recorded).
- Marine groups: `seals`, `whales & dolphins` (`MARINE_GROUPS` in `pipeline/tracks.py`). A step with a fix on
  land (a seal hauled out) is kept: only at-sea to at-sea steps that cross land are split. Birds and land
  mammals are never split for land.
- Land: Natural Earth 10 m land 5.1.1 (public domain), `naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip`,
  3,269,070 bytes, sha256 `e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc`, downloaded once
  into `~/.cache/wildeye/` and refused if the hash differs. Applied after the antimeridian split, in both the
  ATN and the Movebank paths.

## Glide

- The time bar's play steps the shared observed time one step (about a week for tracks) a second, as today
  (A2). The bridge now also tells a layer whether play is running, with the step and the tick
  (`setObservedTime(iso, { playing, stepMs, tickMs })`; layers that take one argument are unchanged).
- While playing, the tracks layer animates the in-span set from the tick's instant to the next tick's over the
  tick: every segment that covers any moment of the step gets a line and a head whose positions are callbacks
  of the animated time, through the same `clipSegmentMs` that draws a paused time (A1; Cesium's
  SampledPositionProperty was the grill's name for it, the existing interpolation is the same straight step
  between fixes and keeps paused and playing identical). A head shows only while its segment covers the
  animated time (A3).
- Paused: the animated time is the bar's instant, so pausing mid-tick puts each head back at the bar's time.

## Not in scope

Smoothing or modelling a path between fixes (straight steps only); playback speed controls; other layers'
animation.

## Acceptance

- `pytest pipeline/tests` (the land split: a step across land between two at-sea fixes splits, a hauled-out fix
  does not, birds never; the zip hash is checked) and `npm test` (the bridge passes the play state; while
  playing the head moves continuously and never past a segment's end or across a gap; paused draws exactly
  what a fresh load at that time draws; work per frame is the in-span set only).
- The real pipeline run (`pipeline/run_tracks.sh`) writes a file in which no at-sea to at-sea step of a marine
  track crosses land (checked against the same land) and the measured split count is reported.
- `scripts/qa-tracks-glide.mjs` against a real build: play with tracks on; heads move between ticks (positions
  sampled inside one tick differ, and stay on their segments); per-frame callback count equals the in-span
  set; no head shown outside its segment's span.
- The maintainer looks and says.
