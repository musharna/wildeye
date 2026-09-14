// src/bio/speciesPanel.test.mjs — choosing a species, suggestion text, and the markup / CSS / startup wiring pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpeciesPanel, suggestionText } from './speciesPanel.js';
import { SPECIES_MAP_LEGEND } from './gbif.js';
import { DATA_CREDITS } from '../data/dataCredits.js';

function fakeElement() {
  return {
    textContent: '', hidden: false, value: '', attrs: {}, listeners: {}, children: [], dataset: {}, type: '', className: '', id: '', style: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

const PANEL_IDS = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-chosen-name', 'species-toggle', 'species-legend', 'species-years', 'species-radius', 'species-what-lives-here'];

function panelRig({ match = async () => 5133088, suggest = async () => ({ source: 'none', items: [] }), setTimer = () => 0 } = {}) {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, fakeElement()]));
  const doc = { getElementById: (id) => els[id] || null, createElement: (tag) => Object.assign(fakeElement(), { tag }) };
  let params = { taxonKey: null, name: null, years: 'recent', radiusKm: 10 };
  let enabled = false;
  const calls = { params: [], enable: [], match: [] };
  const dataManager = {
    getLayerParams: () => ({ ...params }),
    setLayerParams: (id, p, options) => { calls.params.push({ id, p, origin: options.origin }); params = { ...params, ...p }; return true; },
    isEnabled: () => enabled,
    setEnabled: async (id, on, options) => { calls.enable.push({ id, on, origin: options.origin }); enabled = on; return true; },
    subscribe: () => () => {},
  };
  const speciesLayer = { getStats: () => ({ error: null, tileFailures: 0 }), onStatus: () => () => {} };
  const client = {
    match: async (name) => { calls.match.push(name); return match(name); },
    speciesName: async (key) => ({ key, scientificName: 'x', commonName: null }),
    suggest: (q, options) => suggest(q, options),
  };
  const whatLivesHere = { armed: false, arm() {}, disarm() {} };
  const panel = createSpeciesPanel({ doc, dataManager, speciesLayer, client, whatLivesHere, setTimer, clearTimer: () => {} });
  return { panel, els, calls };
}

test('choosing an iNaturalist suggestion matches it in GBIF, sets the taxon and turns the map on', async () => {
  const { panel, els, calls } = panelRig();
  assert.equal(await panel.choose({ gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' }), true);
  assert.deepEqual(calls.match, ['Danaus plexippus']);
  assert.deepEqual(calls.params.at(-1), { id: 'species', p: { taxonKey: 5133088, name: 'Monarch' }, origin: 'user' });
  assert.deepEqual(calls.enable, [{ id: 'species', on: true, origin: 'user' }]);
  assert.equal(els['species-chosen-name'].textContent, 'Monarch');
  assert.equal(els['species-toggle'].textContent, 'MAP ON');
});

test('a GBIF suggestion skips the match; a name GBIF lacks says so and changes nothing', async () => {
  const direct = panelRig();
  await direct.panel.choose({ gbifKey: 6223161, scientificName: 'Danaus plexaure', commonName: null, rank: 'species' });
  assert.deepEqual(direct.calls.match, []);
  assert.equal(direct.calls.params.at(-1).p.taxonKey, 6223161);

  const missing = panelRig({ match: async () => null });
  assert.equal(await missing.panel.choose({ gbifKey: null, scientificName: 'Nonexistus fakeus', commonName: null, rank: 'species' }), false);
  assert.equal(missing.els['species-status'].textContent, 'Nonexistus fakeus is not in GBIF.');
  assert.equal(missing.calls.params.length, 0);
  assert.equal(missing.calls.enable.length, 0);
});

test('suggestion text puts the common name first', () => {
  assert.equal(suggestionText({ commonName: 'Monarch', scientificName: 'Danaus plexippus', rank: 'species' }, 'monarch'), 'Monarch · Danaus plexippus (species)');
  assert.equal(suggestionText({ commonName: null, scientificName: 'Danaus plexaure', rank: 'species' }, 'danaus'), 'Danaus plexaure (species)');
  assert.throws(() => suggestionText({ commonName: 'Monarch', scientificName: 'Danaus plexippus', rank: 'species' }), /query/, 'the typed query is required');
});

// iNaturalist also matches other common names (q=hump, 2026-09-13: Swamp Cicada matched "Hump-back Cicada"). A row says what matched
// only when neither name it shows contains the typed query, so "Humpback Whale" (matched "Hump Whale") needs no note for "hump".
test('suggestion text names the matched term only when neither shown name contains the typed query', () => {
  const whale = { commonName: 'Humpback Whale', scientificName: 'Megaptera novaeangliae', rank: 'species', matchedTerm: 'Hump Whale' };
  const cases = [
    ['hump', { commonName: 'Swamp Cicada', scientificName: 'Neotibicen tibicen', rank: 'species', matchedTerm: 'Hump-back Cicada' }, 'Swamp Cicada · Neotibicen tibicen (species) — matched "Hump-back Cicada"'],
    ['hump', whale, 'Humpback Whale · Megaptera novaeangliae (species)'],
    ['HUMP', whale, 'Humpback Whale · Megaptera novaeangliae (species)'],
    ['  megaptera NOV ', whale, 'Humpback Whale · Megaptera novaeangliae (species)'],
    ['whale hump', whale, 'Humpback Whale · Megaptera novaeangliae (species) — matched "Hump Whale"'],
    ['monarca', { commonName: 'Monarch', scientificName: 'Danaus plexippus', rank: 'species', matchedTerm: 'Monarca' }, 'Monarch · Danaus plexippus (species) — matched "Monarca"'],
    ['hump wh', { commonName: 'Humpback Whale', scientificName: 'Megaptera novaeangliae', rank: 'species', matchedTerm: 'humpback WHALE' }, 'Humpback Whale · Megaptera novaeangliae (species)'],
    ['soldier', { commonName: null, scientificName: 'Danaus plexaure', rank: 'species', matchedTerm: 'Soldier' }, 'Danaus plexaure (species) — matched "Soldier"'],
    ['plexaure', { commonName: null, scientificName: 'Danaus plexaure', rank: 'species', matchedTerm: null }, 'Danaus plexaure (species)'],
  ];
  assert.deepEqual(cases.map(([query, item]) => suggestionText(item, query)), cases.map(([, , text]) => text));
});

test('suggestion rows are worded for the query that was sent, even when the box changed while it was out', async () => {
  let answer = null;
  const sent = [];
  const items = [
    { id: 1, gbifKey: null, scientificName: 'Megaptera novaeangliae', commonName: 'Humpback Whale', rank: 'species', matchedTerm: 'Hump Whale' },
    { id: 2, gbifKey: null, scientificName: 'Neotibicen tibicen', commonName: 'Swamp Cicada', rank: 'species', matchedTerm: 'Hump-back Cicada' },
  ];
  const { els } = panelRig({ suggest: (q) => { sent.push(q); return new Promise((resolve) => { answer = resolve; }); }, setTimer: (fn) => { fn(); return 1; } });
  els['species-search'].value = 'hump';
  els['species-search'].listeners.input();
  assert.deepEqual(sent, ['hump']);
  els['species-search'].value = 'swamp'; // typed on before the answer came back
  answer({ source: 'inaturalist', items });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(els['species-suggestions'].children.map((li) => li.children[0].textContent), [
    'Humpback Whale · Megaptera novaeangliae (species)',
    'Swamp Cicada · Neotibicen tibicen (species) — matched "Hump-back Cicada"',
  ]);
});

// R-7k: GBIF colours hexagons by absolute record counts, so the legend names each class: a swatch in the colour the globe draws it
// (aria-hidden) with its upper bound as text, under a caption. All of it comes from SPECIES_MAP_LEGEND, which gbif.test.mjs pins to
// the tile style.
test('the legend shows each GBIF record-count class as a swatch in its drawn colour with its upper bound as text', () => {
  const { els } = panelRig();
  const legend = els['species-legend'];
  assert.equal(legend.children.length, 2, 'a caption and the class list');
  const [caption, list] = legend.children;
  assert.equal(caption.textContent, 'records per hexagon');
  assert.ok(caption.id, 'the caption has an id');
  assert.equal(list.tag, 'ol');
  assert.equal(list.attrs['aria-labelledby'], caption.id, 'the caption labels the list');
  assert.equal(list.children.length, 6);
  const part = (item, className) => item.children.find((child) => child.className === className);
  const swatches = list.children.map((item) => part(item, 'species-legend-swatch'));
  const labels = list.children.map((item) => part(item, 'species-legend-label'));
  assert.deepEqual(swatches.map((swatch) => swatch.style.backgroundColor), SPECIES_MAP_LEGEND.classes.map((c) => c.color));
  assert.ok(swatches.every((swatch) => swatch.attrs['aria-hidden'] === 'true' && swatch.textContent === ''), 'swatches are decoration only');
  assert.deepEqual(labels.map((label) => label.textContent), ['≤10', '≤100', '≤1k', '≤10k', '≤100k', '>100k']);
  assert.ok(labels.every((label) => label.attrs['aria-hidden'] === undefined), 'the labels are read out');
});

test('the colour legend shows only while the map is on', async () => {
  const { panel, els } = panelRig();
  assert.equal(els['species-legend'].hidden, true, 'no species chosen, map off');
  await panel.choose({ gbifKey: 5133088, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' });
  assert.equal(els['species-toggle'].textContent, 'MAP ON');
  assert.equal(els['species-legend'].hidden, false, 'map on');
  els['species-toggle'].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(els['species-toggle'].textContent, 'MAP OFF');
  assert.equal(els['species-legend'].hidden, true, 'map off again');
});

test('SPECIES panel markup, CSS, Cockpit collapse, startup wiring and credits are in place', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  const stack = html.slice(html.indexOf('<div id="left-panel-stack">'), html.indexOf('<!-- Global Context is deliberately'));
  assert.match(stack, /<div id="species-panel" class="panel-collapsible collapsed" data-panel-id="species-panel">/);
  for (const id of PANEL_IDS) assert.match(stack, new RegExp(`id="${id}"`), id);
  assert.match(stack, /data-collapse-target="species-panel"/);
  assert.doesNotMatch(stack.slice(stack.indexOf('id="species-panel"')), /data-requires-backend/, 'species search works on the static host');
  // The action sits directly after the chosen-species block (its legend inside it), before the chips, so a squeezed
  // panel still shows it; the credit line is last.
  const panelHtml = stack.slice(stack.indexOf('id="species-panel"'));
  // The legend's content is rendered from SPECIES_MAP_LEGEND (speciesPanel.js), so the markup holds an empty container.
  assert.match(panelHtml, /<div id="species-chosen"[^>]*>\s*<span id="species-chosen-name"[^>]*><\/span>\s*<button [^>]*id="species-toggle"[^>]*>MAP OFF<\/button>\s*<div id="species-legend" class="species-legend" hidden><\/div>\s*<\/div>\s*<button [^>]*id="species-what-lives-here"/);
  const order = ['id="species-search"', 'id="species-suggestions"', 'id="species-status"', 'id="species-chosen"', 'id="species-legend"', 'id="species-what-lives-here"', 'id="species-years"', 'id="species-radius"', 'class="species-credit"'];
  const positions = order.map((marker) => panelHtml.indexOf(marker));
  assert.ok(positions.every((at) => at >= 0), `every marker is present: ${JSON.stringify(Object.fromEntries(order.map((m, i) => [m, positions[i]])))}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'markup order');
  assert.doesNotMatch(panelHtml.slice(panelHtml.indexOf('class="species-credit"')), /<button|<input|id="species-/, 'nothing after the credit line');
  assert.match(css, /#left-panel-stack > #species-panel \{[^}]*order: 5;/);
  assert.match(css, /body\.cockpit-mode #left-panel-stack > #species-panel \{ display: none !important; \}/);
  assert.match(css, /#species-panel\.collapsed \.species-body \{ display: none !important; \}/);
  assert.match(css, /\.species-suggestions\[hidden\] \{ display: none; \}/);
  // R-7k: the swatch colours come from SPECIES_MAP_LEGEND, so no legend colour is written in the CSS.
  assert.doesNotMatch(css, /\.species-legend-ramp|#e4e737|#b41c5b/i);
  assert.match(css, /\.species-legend-swatch \{[^}]*height: \d+px;/);
  assert.match(main, /dataManager\.register\(speciesLayer\);/);
  assert.match(main, /createDetailsCard\(\{/);
  assert.match(main, /createDetailsCard\(\{[^\n]*onDismiss: \(\) => whatLivesHere\?\.cancel\(\), onListEnd: \(\) => whatLivesHere\?\.listEnded\(\) \}\)/, 'the card ends the what-lives-here outline');
  assert.match(main, /createWhatLivesHere\(\{/);
  assert.match(main, /createSpeciesPanel\(\{/);
  const cockpit = ui.match(/const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.match(cockpit[1], /'species-panel'/);
  const credit = DATA_CREDITS.find((entry) => entry.key === 'species');
  assert.ok(credit && /GBIF\.org/.test(credit.html) && /iNaturalist/.test(credit.html) && /CC0 and CC BY/.test(credit.html));
});
