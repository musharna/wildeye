// src/bio/effortControl.test.mjs — the RECORDING EFFORT switch in the species card (spec 2026-09-30-effort-layer-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEffortControl } from './effortControl.js';
import { createEffortLayer } from '../data/effort.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const RECORDS = {
  2148457: { key: 2148457, scientificName: 'Trachelas pacificus', className: 'Arachnida', classKey: 367, rank: 'SPECIES' },
  2498205: { key: 2498205, scientificName: 'Anser cygnoides', className: 'Aves', classKey: 212, rank: 'SPECIES' },
  9999999: { key: 9999999, scientificName: 'Incertae sedis', className: null, classKey: null, rank: 'SPECIES' },
};
const settle = async (turns = 10) => { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeElement() {
  return {
    textContent: '', hidden: false, attrs: {}, listeners: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

function rig({ speciesName = async (key) => RECORDS[key] } = {}) {
  const els = { 'species-effort': fakeElement(), 'species-effort-toggle': fakeElement(), 'species-effort-note': fakeElement() };
  const doc = { getElementById: (id) => els[id] ?? null };
  let params = { taxonKey: null, name: null, years: 'recent' };
  const listeners = [];
  const dataManager = {
    getLayerParams: (id) => (id === 'species' ? params : null),
    subscribe: (fn) => listeners.push(fn),
    set(next) { params = { ...params, ...next }; listeners.forEach((fn) => fn({ layerId: 'species' })); },
  };
  const providers = [];
  const layer = createEffortLayer({
    providerFor: (url, options) => {
      const provider = { url, options, errorEvent: { addEventListener: () => {} } };
      providers.push(provider);
      return provider;
    },
    imageryLayerFor: (provider, options) => ({ provider, ...options }),
    stack: () => {},
    now: () => NOW,
  });
  layer.init({ imageryLayers: { add() {}, remove() {} } });
  createEffortControl({ doc, dataManager, client: { speciesName }, layer, now: () => NOW });
  return { dataManager, layer, providers, box: els['species-effort'], toggle: els['species-effort-toggle'], note: els['species-effort-note'] };
}

test('effort row: hidden with no species; a species with a class gets the switch, off, and the note says what it would show', async () => {
  const r = rig();
  assert.equal(r.box.hidden, true);
  r.dataManager.set({ taxonKey: 2148457 });
  assert.equal(r.box.hidden, false);
  assert.equal(r.note.textContent, 'Checking for an effort map…');
  assert.equal(r.toggle.hidden, true, 'no switch until the class is known');
  await settle();
  assert.equal(r.toggle.hidden, false);
  assert.equal(r.toggle.textContent, 'RECORDING EFFORT OFF');
  assert.equal(r.toggle.attrs['aria-checked'], 'false');
  assert.equal(r.note.textContent, 'Where anyone recorded spiders and other arachnids · GBIF CC0/CC BY, 2017–2026 · purple few, white many');
  assert.equal(r.providers.length, 0, 'off: no tiles asked');
  r.toggle.listeners.click();
  assert.equal(r.toggle.textContent, 'RECORDING EFFORT ON');
  assert.equal(r.toggle.attrs['aria-checked'], 'true');
  assert.equal(new URL(r.providers[0].url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.get('taxonKey'), '367');
});

test('effort row: ALL YEARS redraws in all years and the note follows; another class switches it off', async () => {
  const r = rig();
  r.dataManager.set({ taxonKey: 2148457 });
  await settle();
  r.toggle.listeners.click();
  r.dataManager.set({ years: 'all' });
  assert.equal(new URL(r.providers.at(-1).url.replace('{z}/{x}/{y}', '0/0/0')).searchParams.has('year'), false);
  assert.match(r.note.textContent, /GBIF CC0\/CC BY, all years/);
  r.dataManager.set({ taxonKey: 2498205 });
  assert.equal(r.layer.isEnabled(), false, 'a new species starts off');
  await settle();
  assert.equal(r.toggle.textContent, 'RECORDING EFFORT OFF');
  assert.match(r.note.textContent, /^Where anyone recorded birds · GBIF CC0\/CC BY, all years/);
});

test('effort row: no class, no switch; a failed lookup says so; a slow answer for an old pick is dropped', async () => {
  const r = rig();
  r.dataManager.set({ taxonKey: 9999999 });
  await settle();
  assert.equal(r.toggle.hidden, true);
  assert.equal(r.note.textContent, 'No effort map: GBIF lists no class for this species');

  const failing = rig({ speciesName: async () => { throw new Error('HTTP 503'); } });
  failing.dataManager.set({ taxonKey: 2148457 });
  await settle();
  assert.equal(failing.toggle.hidden, true);
  assert.equal(failing.note.textContent, 'No effort map: GBIF lookup failed (HTTP 503)');

  let release;
  const slow = rig({ speciesName: (key) => (key === 2148457 ? new Promise((resolve) => { release = () => resolve(RECORDS[key]); }) : Promise.resolve(RECORDS[key])) });
  slow.dataManager.set({ taxonKey: 2148457 });
  slow.dataManager.set({ taxonKey: 2498205 });
  await settle();
  release();
  await settle();
  assert.match(slow.note.textContent, /recorded birds/, 'the newer pick owns the row');
  slow.dataManager.set({ taxonKey: null });
  assert.equal(slow.box.hidden, true);
});

test('effort row: the markup has the row after the modeled-range row, the switch hidden until a class is known', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const modeled = html.indexOf('id="species-modeled"');
  const effort = html.indexOf('id="species-effort"');
  assert.ok(modeled > 0 && effort > modeled, 'below the modeled row, so it cannot push WHAT LIVES HERE down');
  assert.match(html, /<button type="button" id="species-effort-toggle" class="scene-btn species-switch" role="switch" aria-checked="false" aria-label="Recording effort" hidden>RECORDING EFFORT OFF<\/button>/);
  assert.match(html, /<span id="species-effort-note" class="species-modeled-note" role="status" aria-live="polite"><\/span>/);
});
