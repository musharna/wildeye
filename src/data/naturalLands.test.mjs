// src/data/naturalLands.test.mjs — SBTN Natural Lands drape: the GFW tile URL, the colour groups against the raw-data
// samples, no readout while a colour stands for several classes, the one-drape rule, the legend and the credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  CLASSES,
  GROUPS,
  MAX_LEVEL,
  TILE_FAILURE_LIMIT,
  TILE_URL,
  createNaturalLandsLayer,
  groupLabel,
  naturalLandsLayer,
  oneColourPerClass,
} from './naturalLands.js';
import { DataLayerManager } from './manager.js';
import { installDrapeExclusivity } from './drapeExclusive.js';
import { DATA_CREDITS } from './dataCredits.js';

const repo = (p) => new URL(`../../${p}`, import.meta.url);

// docs/analysis/natlands_legend_samples.tsv: one row a point, written by analysis/natlands_legend.py from the raw
// GeoTIFFs and the live level-12 tiles (2026-10-06)
const SAMPLES = (() => {
  const [head, ...rows] = readFileSync(repo('docs/analysis/natlands_legend_samples.tsv'), 'utf8').trim().split('\n');
  const keys = head.split('\t');
  return rows.map((r) => Object.fromEntries(r.split('\t').map((v, i) => [keys[i], v])));
})();

/** The group a tile colour stands for, by GROUPS; 'clear' for a transparent pixel; null for a colour no group has. */
const groupOf = (rgba) => {
  const c = rgba.split(',').map(Number);
  if (c[3] === 0) return 'clear';
  return GROUPS.find((g) => c[3] === 255 && g.rgb.every((v, i) => v === c[i])) ?? null;
};

test('the drape is the GFW v1.1 default_pro cache, web-mercator XYZ to level 12', async () => {
  assert.equal(TILE_URL, 'https://tiles.globalforestwatch.org/sbtn_natural_lands_classification/v1.1/default_pro/{z}/{x}/{y}.png');
  assert.equal(MAX_LEVEL, 12);
  // the real provider from the layer's own options: the scheme is Cesium's default, web mercator, as the cache is
  const options = [];
  const layer = createNaturalLandsLayer({
    providerFor: (o) => { options.push(o); return new Cesium.UrlTemplateImageryProvider(o); },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: () => {},
  });
  const list = [];
  layer.init({ imageryLayers: { add: (l) => list.push(l), remove: () => true } });
  layer.enable();
  assert.equal(await layer.update(), true);
  const p = list[0].provider;
  assert.ok(p.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.equal(p.maximumLevel, 12);
  assert.equal(p.url, TILE_URL);
  assert.equal(options[0].tilingScheme, undefined);
});

test('every colour in the raw-data samples is one GROUPS colour, and holds only its group\'s classes', () => {
  const homo = SAMPLES.filter((s) => s.homogeneous === '1');
  assert.ok(homo.length >= 300, `homogeneous samples: ${homo.length}`);
  const bad = [];
  const seen = new Map(GROUPS.map((g) => [g, new Set()]));
  for (const s of homo) {
    const g = groupOf(s.rgba);
    const v = Number(s.raw_class);
    if (g === 'clear') { if (v !== 0) bad.push(`${s.lat},${s.lon}: class ${v} drawn clear`); continue; }
    if (!g) { bad.push(`${s.lat},${s.lon}: colour ${s.rgba} is in no group`); continue; }
    if (!g.classes.includes(v)) bad.push(`${s.lat},${s.lon}: class ${v} drawn as ${g.title}`);
    else seen.get(g).add(v);
  }
  assert.deepEqual(bad, []);
  // positive control: each group's colour was seen, and for most of its classes, so the check above had data to fail on
  for (const g of GROUPS) assert.ok(seen.get(g).size >= Math.ceil(g.classes.length / 2), `${g.title}: classes seen ${[...seen.get(g)]}`);
});

test('the groups partition the sheet\'s 20 classes and the legend names every class in its colour', () => {
  const all = GROUPS.flatMap((g) => g.classes).sort((a, b) => a - b);
  assert.deepEqual(all, Object.keys(CLASSES).map(Number).sort((a, b) => a - b));
  assert.deepEqual(all, Array.from({ length: 20 }, (_, k) => k + 2));
  const { legend } = naturalLandsLayer.getRowControls();
  assert.equal(legend.length, GROUPS.length + 1);
  for (const [i, g] of GROUPS.entries()) {
    assert.equal(legend[i].color, `rgb(${g.rgb.join(',')})`);
    assert.equal(legend[i].label, groupLabel(g));
    for (const v of g.classes) assert.ok(legend[i].label.includes(CLASSES[v]), `${g.title} legend names ${CLASSES[v]}`);
  }
  assert.equal(groupLabel(GROUPS[0]), 'Natural forest: natural forests, mangroves, wetland natural forests, natural peat forests');
  assert.match(legend.at(-1).label, /a colour names a group, not a class/);
  assert.match(legend.at(-1).label, /CC BY-SA 4\.0/);
  assert.equal(legend.at(-1).color, 'transparent');
});

test('no readout while a colour stands for several classes; a one-to-one table would allow one', () => {
  assert.equal(oneColourPerClass(GROUPS), false);
  assert.equal(typeof naturalLandsLayer.readoutAt, 'undefined');
  // positive control, and each way a table fails to be one-to-one
  const one = [{ rgb: [1, 1, 1], classes: [2] }, { rgb: [2, 2, 2], classes: [3] }];
  assert.equal(oneColourPerClass(one), true);
  assert.equal(oneColourPerClass([{ rgb: [1, 1, 1], classes: [2, 3] }]), false); // a colour for two classes
  assert.equal(oneColourPerClass([...one, { rgb: [3, 3, 3], classes: [2] }]), false); // a class in two colours
  assert.equal(oneColourPerClass([...one, { rgb: [2, 2, 2], classes: [4] }]), false); // two entries, one colour
  // main.js asks only layers it lists for a readout: this one is not there
  const main = readFileSync(repo('src/main.js'), 'utf8');
  const readList = main.match(/const readGibsLayers = \(\{ lat, lon \}\) => \[\n\s*\.\.\.\[([^\]]+)\]/)?.[1];
  assert.ok(readList?.includes('iflLayer'), 'positive control: the readout list was found');
  assert.ok(!readList.includes('naturalLandsLayer'));
});

test('one drape at a time: main.js lists the layer as a drape, and turning it on turns another drape off', async () => {
  const main = readFileSync(repo('src/main.js'), 'utf8');
  assert.match(main, /import \{ naturalLandsLayer \} from '\.\/data\/naturalLands\.js';/);
  assert.match(main, /dataManager\.register\(naturalLandsLayer\);/);
  const drapes = main.match(/const drapeLayers = \[([^\]]+)\];/)?.[1].split(',').map((s) => s.trim());
  assert.ok(drapes?.includes('iflLayer'), 'positive control: the drape list was found');
  assert.ok(drapes.includes('naturalLandsLayer'), 'naturalLandsLayer is in drapeLayers');
  // the rule over the real manager with the real id: on → the other drape off, and the other way round
  const fake = (id) => ({ id, name: id, icon: '', source: 't', updateInterval: -1, async init() {}, enable() {}, disable() {}, async update() { return true; }, getStats() { return { count: 0, lastUpdate: null }; } });
  const run = async (ids) => {
    const mgr = new DataLayerManager({});
    for (const id of [naturalLandsLayer.id, 'ifl']) mgr.register(fake(id));
    installDrapeExclusivity(mgr, ids);
    await mgr.setEnabled('ifl', true, { origin: 'user' });
    await mgr.setEnabled(naturalLandsLayer.id, true, { origin: 'user' });
    const a = [mgr.isEnabled('ifl'), mgr.isEnabled(naturalLandsLayer.id)];
    await mgr.setEnabled('ifl', true, { origin: 'user' });
    return [...a, mgr.isEnabled(naturalLandsLayer.id)];
  };
  assert.deepEqual(await run(['ifl', 'natural-lands']), [false, true, false]);
  assert.deepEqual(await run(['ifl']), [true, true, true]); // control: left out of the list, the two stack
});

test('a 2020 baseline: not on the time bar', () => {
  assert.equal(naturalLandsLayer.setObservedTime, undefined);
  assert.equal(naturalLandsLayer.getObservedExtent, undefined);
  const main = readFileSync(repo('src/main.js'), 'utf8');
  const observed = main.match(/const observedLayers = \[([^\]]+)\];/)?.[1];
  assert.ok(observed?.includes('hansenLossLayer'), 'positive control: the observed list was found');
  assert.ok(!observed.includes('naturalLandsLayer'));
  assert.equal(naturalLandsLayer.getStats().time, '2020');
});

function harness() {
  const providers = [], list = [], stacked = [];
  const viewer = { imageryLayers: { add: (l) => list.push(l), remove: (l) => { list.splice(list.indexOf(l), 1); return true; } } };
  const layer = createNaturalLandsLayer({
    providerFor: (options) => {
      const listeners = [];
      const p = { options, errorEvent: { addEventListener: (fn) => listeners.push(fn) }, fail: (error) => listeners.forEach((fn) => fn({ error })) };
      providers.push(p);
      return p;
    },
    imageryLayerFor: (provider) => ({ provider, show: true }),
    stack: (_layers, id, imagery, zrank) => stacked.push({ id, imagery, zrank }),
  });
  layer.init(viewer);
  return { layer, providers, list, stacked };
}

test('draws once, stacked with the land drapes; enable and disable show and hide it without a redraw', async () => {
  const { layer, providers, list, stacked } = harness();
  assert.equal(await layer.update(), true);
  assert.equal(list[0].show, false); // built while off
  layer.enable();
  assert.equal(list[0].show, true);
  await layer.update();
  assert.equal(providers.length, 1);
  assert.deepEqual(stacked.at(-1), { id: 'natural-lands', imagery: list[0], zrank: 21 });
  layer.disable();
  assert.equal(list[0].show, false);
  await layer.update();
  assert.equal(list[0].show, false);
  assert.equal(providers.length, 1);
  layer.destroy();
  assert.equal(list.length, 0);
  assert.deepEqual(stacked.at(-1), { id: 'natural-lands', imagery: null, zrank: undefined });
  assert.equal(await layer.update(), false); // no viewer
});

test('tile failures surface at the limit; the next update rebuilds, and the old provider no longer counts', async () => {
  const { layer, providers } = harness();
  layer.enable();
  await layer.update();
  for (let k = 0; k < TILE_FAILURE_LIMIT - 1; k++) providers[0].fail(new Error('x'));
  assert.equal(layer.getStats().error, null);
  providers[0].fail(new Error('x'));
  assert.equal(layer.getStats().error, 'map tiles failing');
  await layer.update();
  assert.equal(providers.length, 2);
  assert.equal(layer.getStats().error, null);
  for (let k = 0; k < TILE_FAILURE_LIMIT; k++) providers[0].fail(new Error('late'));
  assert.equal(layer.getStats().error, null);
});

test('credit: CC BY-SA 4.0 and the README\'s citation, verbatim', () => {
  const c = DATA_CREDITS.find((e) => e.key === 'natural-lands');
  assert.ok(c, 'DATA_CREDITS has a natural-lands entry');
  // wri/natural-lands-map README "Citation" (read 2026-10-06)
  assert.ok(c.html.includes('Mazur, E., M. Sims, E. Goldman, M. Schneider, M.D. Pirri, C.R. Beatty, F. Stolle, Stevenson, M. 2025. “SBTN Natural Lands Map v1.1: Technical Documentation”. <i>Science Based Targets for Land Version 1-- Supplementary Material</i>. Science Based Targets Network.'));
  assert.ok(c.html.includes('https://creativecommons.org/licenses/by-sa/4.0/'));
  assert.ok(c.html.includes('CC BY-SA 4.0'));
  assert.equal(naturalLandsLayer.source, 'WRI / SBTN Natural Lands Map v1.1 via Global Forest Watch · CC BY-SA 4.0');
});
