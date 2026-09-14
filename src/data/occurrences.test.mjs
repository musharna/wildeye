// src/data/occurrences.test.mjs — GBIF/OBIS sightings layer: pure helpers + contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOccurrencesLayer, ageAlpha, pointEntity, describeOccurrence, licenceLabel, GROUP_COLORS } from './occurrences.js';

const NOW = Date.parse('2026-09-11T00:00:00Z');

test('ageAlpha: today bright, window-old faded, garbage faded', () => {
  assert.equal(ageAlpha('2026-09-11', NOW), 1);
  assert.ok(Math.abs(ageAlpha('2026-07-13', NOW) - 0.625) < 0.01);   // 60 of 120 days
  assert.equal(ageAlpha('2026-01-01', NOW), 0.25);
  assert.equal(ageAlpha('nope', NOW), 0.25);
});

test('pointEntity: id is stable, colour by group, age drives alpha', () => {
  const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [-53.09, 48.7] },
    properties: { taxon: 'humpback', name: 'Humpback whale', sci: 'Megaptera novaeangliae', group: 'whales', icon: '🐋',
      date: '2026-09-11', source: 'obis', license: 'https://creativecommons.org/publicdomain/zero/1.0/', basis: 'HumanObservation' } };
  const e = pointEntity(f, NOW);
  assert.equal(e.id, 'occ:humpback:2026-09-11:0');
  assert.equal(pointEntity(f, NOW, 120, 7).id, 'occ:humpback:2026-09-11:7');
  assert.equal(e.point.color.alpha, 1);
  assert.equal(e.properties.lat, 48.7);
  const old = pointEntity({ ...f, properties: { ...f.properties, date: '2026-01-01', group: 'zzz' } }, NOW);
  assert.equal(old.point.color.alpha, 0.25);
  assert.ok(Object.keys(GROUP_COLORS).includes('whales'));
  assert.match(describeOccurrence(f.properties), /Humpback whale.*CC0 1\.0/s);
  // distinct licences are never collapsed; publisher + DOI come from the datasets map
  const by = { ...f.properties, license: 'http://creativecommons.org/licenses/by/4.0/legalcode', dataset_key: 'dk', uncertainty_m: 12.4 };
  const html = describeOccurrence(by, { dk: { title: 'Whale survey', publisher: 'Acme Inst', doi: '10.1/abc' } });
  assert.match(html, /CC BY 4\.0/); assert.doesNotMatch(html, /CC0/);
  assert.match(html, /±12 m.*Whale survey — Acme Inst.*doi\.org\/10\.1\/abc/s);
  // S7: the DOI starts its own line, so a wrap can never leave a separator dot at the start of a line.
  assert.match(html, /Whale survey — Acme Inst<br><a href="https:\/\/doi\.org\/10\.1\/abc"[^>]*>doi:10\.1\/abc<\/a><br>/);
  assert.doesNotMatch(html, /· <a href="https:\/\/doi\.org/);
  assert.equal(licenceLabel('https://example.org/weird'), 'https://example.org/weird');
  assert.match(describeOccurrence({ ...by, name: '<img src=x>' }), /&lt;img/);
});

test('occurrences: layer contract and group chips', () => {
  const l = createOccurrencesLayer();
  assert.equal(l.id, 'occurrences');
  for (const k of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'getAnalystRecords', 'getRowControls', 'setParams', 'getParams'])
    assert.equal(typeof l[k], 'function');
  assert.deepEqual(l.getAnalystRecords(), []);
  assert.deepEqual(l.getRowControls().chips, []);
  assert.equal(l.setParams({ whales: false }), false);   // unknown group before any data: no-op
});

test('update: records that collide at 4 decimals still load (duplicate-id regression)', async () => {
  // 36.80545 and 36.80554 sit in different 0.001° pipeline dedupe cells but both
  // print as 36.8055 — a coordinate-hash id made Cesium throw and the layer read LOAD FAILED.
  const mk = (lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-121.9413, lat] },
    properties: { taxon: 'orca', group: 'whales', date: '2026-06-03', name: 'Orca', sci: 'Orcinus orca' } });
  const gj = { type: 'FeatureCollection', window_days: 120, features: [mk(36.80545), mk(36.80554)] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createOccurrencesLayer();
    l.init({ dataSources: { add() {}, remove() {} } });
    assert.equal(await l.update(), true, l.getStats().error);
    assert.equal(l.getStats().count, 2);
    assert.equal(l.getRowControls().chips[0].label, 'WHALES 2');
    assert.equal(l.getStats().truncated.length, 0);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...gj, truncated: ['orca'] }) });
    await l.update();
    assert.match(l.getRowControls().legend.map((x) => x.label).join('|'), /partial: orca/);
    // positive control for the error path: a bad payload must still be reported, not thrown
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
    assert.equal(await l.update(), false);
    assert.match(l.getStats().error, /Malformed/);
  } finally { globalThis.fetch = saved; }
});

test('occurrences: setObservedTime hides records after the instant and fades by age relative to it', async () => {
  const mk = (date) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { taxon: 'orca', group: 'whales', date, name: 'Orca', sci: 'Orcinus orca' } });
  const gj = { type: 'FeatureCollection', window_days: 120, features: [mk('2026-09-01'), mk('2026-09-10')] };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => gj });
  try {
    const l = createOccurrencesLayer();
    let ds; l.init({ dataSources: { add(d) { ds = d; }, remove() {} } });
    assert.equal(await l.update(), true);
    assert.equal(l.getStats().visible, 2);
    assert.equal(l.setObservedTime('2026-09-05T00:00:00Z'), true);
    assert.equal(l.getStats().visible, 1, 'the 09-10 record is in the future of the selected instant');
    const alphaSep1 = ds.entities.values.find((e) => e.show).point.color.getValue().alpha;
    assert.ok(alphaSep1 > 0.9, `age 4 d at the selected instant should be bright, got ${alphaSep1}`);
    assert.equal(l.setObservedTime(null), true);
    assert.equal(l.getStats().visible, 2);
    assert.equal(l.setObservedTime('bad'), false);
  } finally { globalThis.fetch = saved; }
});

test('basisText lowercases GBIF codes but keeps free text (recordist names) intact', async () => {
  const { basisText } = await import('./occurrences.js');
  assert.equal(basisText('HUMAN_OBSERVATION'), 'human observation');
  assert.equal(basisText('birds song by Victor Aleksanov (quality A)'), 'birds song by Victor Aleksanov (quality A)');
  assert.equal(basisText(undefined), '');
});

test('IUCN badge appears in the sightings info box only for taxa with a category', async () => {
  const { _resetIucn } = await import('./iucn.js');
  const { describeOccurrence } = await import('./occurrences.js');
  const base = { icon: '🐧', name: 'Puffin', sci: 'Fratercula arctica', date: '2026-09-01', basis: 'HUMAN_OBSERVATION', source: 'gbif' };
  _resetIucn({ puffin: { category: 'EN', year: 2021, citation: 'c', url: 'https://www.iucnredlist.org/species/1/2' } });
  try {
    assert.match(describeOccurrence({ ...base, taxon: 'puffin' }), /Fratercula arctica<\/i> · <a href="https:\/\/www\.iucnredlist\.org\/species\/1\/2".*>EN<\/span><\/a> IUCN Endangered 2021<br>/);
    assert.doesNotMatch(describeOccurrence({ ...base, taxon: 'orca' }), /IUCN/, 'positive control above; no entry → no badge');
  } finally { _resetIucn({}); }
});
