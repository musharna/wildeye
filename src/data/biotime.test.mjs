// src/data/biotime.test.mjs — BioTIME study series: year state, description (raw counts beside effort), extent, entities, layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearOf, studyAt, describeStudy, studiesExtent, TAXA, taxonColor } from './biotime.js';

const study = {
  id: 10, title: 'Windstorm <disturbance>', organisms: 'woody plants', taxa: 'Plants', realm: 'Terrestrial',
  lat: 47.4, lon: -95.12, areaKm2: 5.9e-6, wide: false, licence: 'CC-by', link: 'http://esapubs.org/x',
  citations: ['Webb & Scanga (2001). Windstorm. Ecology 82(3):893-897. doi:10.2307/2680207', 'B (2002). T2.', 'C (2003). T3.', 'D (2004). T4.'],
  years: { 1984: [25, 164], 1990: [30, 40], 1996: [28, 41] },
};
const source = { name: 'BioTIME 2.0', doi: '10.1111/geb.70003', citation: 'Dornelas, M., et al. (2025). BioTIME 2.0' };

test('yearOf: the UTC calendar year of an instant; live is null; garbage is refused', () => {
  assert.equal(yearOf(null), null);
  assert.equal(yearOf('1990-12-31T23:59:59Z'), 1990);
  assert.equal(yearOf('1991-01-01T00:00:00Z'), 1991);
  assert.throws(() => yearOf('garbage'), /instant/);
});

test('studyAt: live = the latest sampled year; a sampled year; a year between samples is a named gap; outside the span hidden', () => {
  assert.deepEqual(studyAt(study, null), { status: 'sampled', year: 1996, taxa: 28, samples: 41 });
  assert.deepEqual(studyAt(study, 1990), { status: 'sampled', year: 1990, taxa: 30, samples: 40 });
  assert.deepEqual(studyAt(study, 1987), { status: 'gap', year: 1987, before: 1984, after: 1990 });
  assert.deepEqual(studyAt(study, 1983), { status: 'hidden', year: 1983 });
  assert.deepEqual(studyAt(study, 1997), { status: 'hidden', year: 1997 });
});

test('describeStudy: escaped title, raw count beside its samples, the effort caveat, citations, licence and the BioTIME credit', () => {
  const html = describeStudy(study, studyAt(study, 1990), source);
  assert.match(html, /<b>Windstorm &lt;disturbance&gt;<\/b>/);
  assert.match(html, /woody plants · Plants · Terrestrial/);
  assert.match(html, /Sampled in 3 years, 1984–1996/);
  assert.match(html, /1990: 30 taxa in 40 samples/);
  assert.match(html, /Raw counts: more samples find more taxa, so years are not directly comparable/);
  assert.match(html, /Webb &amp; Scanga \(2001\).*B \(2002\).*C \(2003\).*\+1 more/s);
  assert.doesNotMatch(html, /D \(2004\)/, 'three citations, then a count');
  assert.match(html, /Licence: CC-by/);
  assert.match(html, /href="https:\/\/doi\.org\/10\.1111\/geb\.70003"/);
  assert.doesNotMatch(html, /trend|increase|decline/i, 'never a trend');
  const gap = describeStudy(study, studyAt(study, 1987), source);
  assert.match(gap, /Not sampled in 1987 \(sampled 1984 and 1990\)/);
  assert.doesNotMatch(gap, /taxa in/);
  const one = describeStudy({ ...study, years: { 2001: [1, 1] } }, { status: 'sampled', year: 2001, taxa: 1, samples: 1 }, source);
  assert.match(one, /Sampled in 1 year, 2001/);
  assert.match(one, /2001: 1 taxon in 1 sample\b/);
  const wide = describeStudy({ ...study, wide: true, areaKm2: 250000 }, studyAt(study, 1990), source);
  assert.match(wide, /Spans about 250,000 km²: the dots are the places sampled in 1990/);
});

test('studiesExtent: from the first sampled year\'s first instant to the last year\'s last; none is null', () => {
  const e = studiesExtent([study, { ...study, years: { 1874: [1, 1], 2023: [2, 2] } }]);
  assert.equal(new Date(e.startMs).toISOString(), '1874-01-01T00:00:00.000Z');
  assert.equal(new Date(e.endMs).toISOString(), '2023-12-31T23:59:59.999Z');
  assert.equal(studiesExtent([]), null);
});

test('taxon groups: nine, each its own colour; an unknown group is grey, not another group\'s colour', () => {
  assert.equal(TAXA.length, 9);
  assert.equal(new Set(TAXA.map((t) => taxonColor(t))).size, 9);
  assert.ok(!TAXA.map((t) => taxonColor(t)).includes(taxonColor('Lichens')));
});

const { studyEntity, studyCells, createBiotimeLayer } = await import('./biotime.js');
const wideStudy = { ...study, id: 30, title: 'Seabirds at sea', taxa: 'Birds', wide: true, areaKm2: 250000, years: { 2001: [5, 3], 2004: [6, 2] } };
const LOCS = { 30: { 2001: [[150.01, -30.0], [151.0, -31.5]], 2004: [[149.0, -29.0]] } };

test('studyEntity / studyCells: a small study is one dot (faded in a gap); a wide study draws its cells when sampled, a faded dot in a gap', () => {
  const e = studyEntity(study, studyAt(study, 1990), source);
  assert.equal(e.id, 'biotime:10');
  assert.equal(e.point.color.alpha, 1);
  assert.equal(e.properties.taxa, 30);
  assert.equal(e.properties.samples, 40);
  assert.ok(studyEntity(study, studyAt(study, 1987), source).point.color.alpha < 0.3, 'gap → faded');
  assert.equal(studyEntity(study, studyAt(study, 1983), source), null, 'outside the span → hidden');
  assert.deepEqual(studyCells(study, studyAt(study, 1990), LOCS), [], 'a small study has no cells');
  assert.equal(studyEntity(wideStudy, studyAt(wideStudy, 2001), source), null, 'a sampled wide study is not a centroid');
  assert.deepEqual(studyCells(wideStudy, studyAt(wideStudy, 2001), LOCS), LOCS[30][2001]);
  assert.deepEqual(studyCells(wideStudy, studyAt(wideStudy, null), LOCS), LOCS[30][2004], 'live = latest sampled year');
  const gap = studyEntity(wideStudy, studyAt(wideStudy, 2002), source);
  assert.ok(gap.point.color.alpha < 0.3);
  assert.match(gap.description, /Not sampled in 2002/);
  assert.deepEqual(studyCells(wideStudy, studyAt(wideStudy, 2002), LOCS), []);
});

function harness({ manifest, locs = LOCS, status = 200, locStatus = 200 } = {}) {
  const fetches = [], points = [], sources = [];
  const m = manifest ?? { studies: [study, wideStudy], dropped: { 'non-commercial': 37, 'share-alike': 70, unclear: 42 }, locations: 'data/biotime_locations.json', source };
  const handler = {};
  let pickResult = null;
  const viewer = {
    dataSources: { add: (d) => sources.push(d), remove: () => true },
    scene: { canvas: {}, primitives: { add: (p) => p, remove: () => true }, pick: () => pickResult },
    selectedEntity: null,
  };
  const layer = createBiotimeLayer({
    fetchImpl: async (u) => {
      fetches.push(u);
      const loc = u.includes('locations');
      return { ok: (loc ? locStatus : status) === 200, status: loc ? locStatus : status, json: async () => structuredClone(loc ? locs : m) };
    },
    pointsFor: () => ({ show: false, add: (o) => points.push(o), removeAll: () => { points.length = 0; } }),
    clickHandlerFor: () => ({ setInputAction: (fn) => { handler.click = fn; }, destroy: () => {} }),
  });
  layer.init(viewer);
  return { layer, fetches, points, sources, viewer, handler, pick: (r) => { pickResult = r; } };
}
const entityIds = (h) => h.sources[0].entities.values.map((e) => e.id).sort();

test('layer: reads the release once; live = latest year; the time bar picks the year; chips hide a group; extent from sampled years', async () => {
  const h = harness();
  assert.equal(await h.layer.update(), true);
  assert.deepEqual(h.fetches, ['data/biotime.json', 'data/biotime_locations.json']);
  assert.deepEqual(entityIds(h), ['biotime:10']);
  assert.equal(h.points.length, 1, 'wide study live: its 2004 cell');
  assert.equal(h.points[0].id, 'biotime-cell:30');
  await h.layer.update();
  assert.equal(h.fetches.length, 2, 'a fixed release is not re-read');
  h.layer.setObservedTime('2001-06-01T00:00:00Z');
  assert.deepEqual(entityIds(h), [], 'small study outside its span, wide study drawn as cells');
  assert.equal(h.points.length, 2);
  h.layer.setObservedTime('1987-06-01T00:00:00Z');
  assert.equal(h.sources[0].entities.getById('biotime:10').properties.status.getValue(), 'gap');
  assert.equal(h.points.length, 0);
  h.layer.setObservedTime(null);
  h.layer.setParams({ Birds: false });
  assert.equal(h.points.length, 0, 'Birds hidden → the wide bird study is gone');
  assert.deepEqual(entityIds(h), ['biotime:10']);
  const { chips, legend } = h.layer.getRowControls();
  assert.equal(chips.length, 9);
  assert.equal(chips.find((c) => c.id === 'Birds').active, false);
  assert.match(legend.at(-1).label, /raw counts, not trends · 149 studies under non-open licences left out/);
  const e = h.layer.getObservedExtent();
  assert.equal(new Date(e.startMs).getUTCFullYear(), 1984);
  assert.equal(new Date(e.endMs).getUTCFullYear(), 2004);
  assert.equal(h.layer.setObservedTime('garbage'), false);
  assert.equal(h.layer.getStats().error, null);
});

test('a click on a wide study\'s cell opens that study at that year; other picks are ignored', async () => {
  const h = harness();
  await h.layer.update();
  h.layer.enable();
  h.layer.setObservedTime('2001-03-01T00:00:00Z');
  h.pick({ primitive: { id: 'biotime-cell:30', position: h.points[0].position } });
  h.handler.click({ position: {} });
  const sel = h.viewer.selectedEntity;
  assert.equal(sel.properties.study.getValue(), 30);
  assert.equal(sel.properties.taxa.getValue(), 5);
  assert.match(sel.description.getValue(), /2001: 5 taxa in 3 samples/);
  h.viewer.selectedEntity = null;
  h.pick({ primitive: { id: 'birds-particle:3' } });
  h.handler.click({ position: {} });
  assert.equal(h.viewer.selectedEntity, null);
  h.layer.disable();
  h.pick({ primitive: { id: 'biotime-cell:30', position: h.points[0].position } });
  h.handler.click({ position: {} });
  assert.equal(h.viewer.selectedEntity, null, 'off → clicks ignored');
});

test('a missing or malformed release, or missing locations, is loud and draws nothing', async () => {
  for (const [opts, why] of [[{ status: 404 }, /biotime\.json HTTP 404/], [{ manifest: { studies: [{ id: 'x' }] } }, /Malformed biotime\.json/], [{ locStatus: 404 }, /biotime_locations\.json HTTP 404/]]) {
    const h = harness(opts);
    assert.equal(await h.layer.update(), false);
    assert.match(h.layer.getStats().error, why);
    assert.equal(h.points.length, 0);
    assert.equal(h.sources[0].entities.values.length, 0);
  }
});
