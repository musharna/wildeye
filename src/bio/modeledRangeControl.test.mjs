// src/bio/modeledRangeControl.test.mjs — the MODELED RANGE switch in the species card (spec 2026-09-30-modeled-range-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createModeledRangeControl } from './modeledRangeControl.js';
import { createModeledRangeLayer, THROTTLED_MESSAGE } from '../data/modeledRange.js';

const LIST = {
  verdicts_generated_at: '2026-09-30T17:32:10+00:00',
  species_iou_min: 0.7,
  groups: {
    Arachnida: { verdict: 'pass', include: [367], exclude: [] },
    Aves: { verdict: 'fail', include: [212], exclude: [] },
  },
  species: { 'Trachelas pacificus': { id: 298342, group: 'Arachnida', iou: 0.93 } },
};
const RECORDS = {
  2148457: { key: 2148457, scientificName: 'Trachelas pacificus', commonName: null, rank: 'SPECIES', lineage: [1, 54, 367, 2148457] },
  2498205: { key: 2498205, scientificName: 'Anser cygnoides', commonName: 'Swan Goose', rank: 'SPECIES', lineage: [1, 44, 212, 2498205] },
};
const settle = async (turns = 10) => { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeElement() {
  return {
    textContent: '', hidden: false, attrs: {}, listeners: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

function rig({ list = async () => LIST, speciesName = async (key) => RECORDS[key] } = {}) {
  const els = { 'species-modeled': fakeElement(), 'species-modeled-toggle': fakeElement(), 'species-modeled-note': fakeElement() };
  const doc = { getElementById: (id) => els[id] ?? null };
  let params = { taxonKey: null, name: null };
  const listeners = [];
  const dataManager = {
    getLayerParams: (id) => (id === 'species' ? params : null),
    subscribe: (fn) => listeners.push(fn),
    pick(taxonKey) { params = { taxonKey, name: null }; listeners.forEach((fn) => fn({ layerId: 'species' })); },
  };
  const providers = [];
  const layer = createModeledRangeLayer({
    providerFor: (url, options) => {
      const fns = [];
      const provider = { url, options, errorEvent: { addEventListener: (fn) => fns.push(fn) }, fail: (error) => fns.forEach((fn) => fn({ error })) };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, ...options }),
    stack: () => {},
    scheduler: { requestsByServer: {} },
    readTilePixel: async () => ({ rgba: [0, 0, 0, 0] }),
  });
  const viewer = { imageryLayers: { list: [], add(l) { this.list.push(l); }, remove(l) { this.list = this.list.filter((x) => x !== l); } } };
  layer.init(viewer);
  createModeledRangeControl({ doc, dataManager, client: { speciesName }, layer, loadList: list });
  const box = els['species-modeled'];
  const toggle = els['species-modeled-toggle'];
  const note = els['species-modeled-note'];
  return { dataManager, layer, viewer, providers, box, toggle, note };
}

test('a spider of a passing collection gets the switch, off; on draws its modeled range', async () => {
  const { dataManager, layer, viewer, box, toggle, note } = rig();
  assert.equal(box.hidden, true, 'no species, no row');
  dataManager.pick(2148457);
  assert.equal(note.textContent, 'Checking for a modeled range…');
  await settle();
  assert.equal(box.hidden, false);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent, 'MODELED RANGE OFF');
  assert.equal(toggle.attrs['aria-checked'], 'false');
  assert.equal(note.textContent, 'iNaturalist Geomodel · Arachnida passed validation September 2026');
  assert.equal(viewer.imageryLayers.list.length, 0, 'off by default (grill Q7)');
  toggle.listeners.click();
  assert.equal(layer.isEnabled(), true);
  assert.equal(toggle.textContent, 'MODELED RANGE ON');
  assert.equal(toggle.attrs['aria-checked'], 'true');
  assert.equal(viewer.imageryLayers.list.length, 1);
  assert.match(viewer.imageryLayers.list[0].provider.url, /geomodel\/298342\//);
});

test('a bird of a failed collection gets no switch and the reason; picking it turns the spider range off', async () => {
  const { dataManager, layer, viewer, toggle, note } = rig();
  dataManager.pick(2148457);
  await settle();
  toggle.listeners.click();
  assert.equal(viewer.imageryLayers.list.length, 1); // positive control: the spider's range was on
  dataManager.pick(2498205);
  assert.equal(viewer.imageryLayers.list.length, 0, 'a new species removes the old range at once');
  await settle();
  assert.equal(toggle.hidden, true);
  assert.equal(note.textContent, 'No modeled range: Aves failed validation (September 2026)');
  assert.equal(layer.isEnabled(), false);
  // re-arming the old key does not resurrect it: the switch starts off again
  dataManager.pick(2148457);
  await settle();
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent, 'MODELED RANGE OFF');
});

test('a slow lookup for an earlier pick never overwrites the later one', async () => {
  let releaseSpider;
  const speciesName = (key) => (key === 2148457 ? new Promise((resolve) => { releaseSpider = () => resolve(RECORDS[key]); }) : Promise.resolve(RECORDS[key]));
  const { dataManager, toggle, note, layer } = rig({ speciesName });
  dataManager.pick(2148457);
  dataManager.pick(2498205);
  await settle();
  assert.equal(note.textContent, 'No modeled range: Aves failed validation (September 2026)');
  releaseSpider();
  await settle();
  assert.equal(note.textContent, 'No modeled range: Aves failed validation (September 2026)');
  assert.equal(toggle.hidden, true);
  assert.equal(layer.getStatus().taxon, null);
});

test('a list that fails to load is said in the card, not a missing row; a failed GBIF lookup too', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const noList = rig({ list: async () => { throw new Error('HTTP 404'); } });
    noList.dataManager.pick(2148457);
    await settle();
    assert.equal(noList.box.hidden, false);
    assert.equal(noList.toggle.hidden, true);
    assert.equal(noList.note.textContent, 'Modeled ranges unavailable: the validation list failed to load (HTTP 404)');
    const noName = rig({ speciesName: async () => { throw new Error('HTTP 503'); } });
    noName.dataManager.pick(2148457);
    await settle();
    assert.equal(noName.note.textContent, 'No modeled range: GBIF lookup failed (HTTP 503)');
  } finally {
    console.error = originalError;
  }
});

test('iNaturalist throttling shows in the card while the range is on', async () => {
  const { dataManager, toggle, note, providers } = rig();
  dataManager.pick(2148457);
  await settle();
  toggle.listeners.click();
  const originalError = console.error;
  console.error = () => {};
  try {
    providers.at(-1).fail(new Cesium.RequestErrorEvent(429));
  } finally {
    console.error = originalError;
  }
  assert.equal(note.textContent, THROTTLED_MESSAGE);
});

test('markup: the switch row follows WHAT LIVES HERE, outside the chosen block (phone-landscape fold), a switch with a live note', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const chosen = html.slice(html.indexOf('id="species-chosen"'), html.indexOf('id="species-what-lives-here"'));
  assert.doesNotMatch(chosen, /species-modeled/);
  assert.match(chosen, /id="species-chosen-note"/); // positive control: the slice is the chosen block
  const after = html.slice(html.indexOf('id="species-what-lives-here"'), html.indexOf('class="species-chip-group"'));
  assert.match(after, /<div id="species-modeled" class="species-modeled" hidden>/);
  assert.match(after, /<button type="button" id="species-modeled-toggle" class="scene-btn species-switch" role="switch" aria-checked="false" aria-label="Modeled range" hidden>MODELED RANGE OFF<\/button>/);
  assert.match(after, /<span id="species-modeled-note" class="species-modeled-note" role="status" aria-live="polite"><\/span>/);
});
