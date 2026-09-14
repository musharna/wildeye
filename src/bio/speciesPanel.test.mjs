// src/bio/speciesPanel.test.mjs — choosing a species, suggestion text, and the markup / CSS / startup wiring pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpeciesPanel, suggestionText } from './speciesPanel.js';
import { DATA_CREDITS } from '../data/dataCredits.js';

function fakeElement() {
  return {
    textContent: '', hidden: false, value: '', attrs: {}, listeners: {}, children: [], dataset: {}, type: '', className: '',
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children = kids; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

const PANEL_IDS = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-chosen-name', 'species-toggle', 'species-legend', 'species-years', 'species-radius', 'species-what-lives-here'];

function panelRig({ match = async () => 5133088 } = {}) {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, fakeElement()]));
  const doc = { getElementById: (id) => els[id] || null, createElement: () => fakeElement() };
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
    suggest: async () => ({ source: 'none', items: [] }),
  };
  const whatLivesHere = { armed: false, arm() {}, disarm() {} };
  const panel = createSpeciesPanel({ doc, dataManager, speciesLayer, client, whatLivesHere, setTimer: () => 0, clearTimer: () => {} });
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
  assert.equal(suggestionText({ commonName: 'Monarch', scientificName: 'Danaus plexippus', rank: 'species' }), 'Monarch · Danaus plexippus (species)');
  assert.equal(suggestionText({ commonName: null, scientificName: 'Danaus plexaure', rank: 'species' }), 'Danaus plexaure (species)');
});

// iNaturalist also matches other common names (q=hump, 2026-09-13: Swamp Cicada matched "Hump-back Cicada"), so a row
// says what matched when that is not a name the row already shows.
test('suggestion text names the matched term only when it differs from the common and the scientific name', () => {
  const cases = [
    [{ commonName: 'Swamp Cicada', scientificName: 'Neotibicen tibicen', rank: 'species', matchedTerm: 'Hump-back Cicada' }, 'Swamp Cicada · Neotibicen tibicen (species) — matched "Hump-back Cicada"'],
    [{ commonName: 'Humpback Whale', scientificName: 'Megaptera novaeangliae', rank: 'species', matchedTerm: 'Hump Whale' }, 'Humpback Whale · Megaptera novaeangliae (species) — matched "Hump Whale"'],
    [{ commonName: 'Humpback Whales', scientificName: 'Megaptera', rank: 'genus', matchedTerm: 'Humpback Whales' }, 'Humpback Whales · Megaptera (genus)'],
    [{ commonName: 'Humpback Whales', scientificName: 'Megaptera', rank: 'genus', matchedTerm: 'humpback WHALES' }, 'Humpback Whales · Megaptera (genus)'],
    [{ commonName: 'Monarch', scientificName: 'Danaus plexippus', rank: 'species', matchedTerm: 'danaus plexippus' }, 'Monarch · Danaus plexippus (species)'],
    [{ commonName: null, scientificName: 'Danaus plexaure', rank: 'species', matchedTerm: 'Danaus plexaure' }, 'Danaus plexaure (species)'],
    [{ commonName: null, scientificName: 'Danaus plexaure', rank: 'species', matchedTerm: null }, 'Danaus plexaure (species)'],
    [{ commonName: null, scientificName: 'Danaus plexaure', rank: 'species', matchedTerm: 'Soldier' }, 'Danaus plexaure (species) — matched "Soldier"'],
  ];
  assert.deepEqual(cases.map(([item]) => suggestionText(item)), cases.map(([, text]) => text));
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
  assert.match(panelHtml, /<div id="species-chosen"[^>]*>\s*<span id="species-chosen-name"[^>]*><\/span>\s*<button [^>]*id="species-toggle"[^>]*>MAP OFF<\/button>\s*<div id="species-legend"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<button [^>]*id="species-what-lives-here"/);
  const order = ['id="species-search"', 'id="species-suggestions"', 'id="species-status"', 'id="species-chosen"', 'id="species-legend"', 'id="species-what-lives-here"', 'id="species-years"', 'id="species-radius"', 'class="species-credit"'];
  const positions = order.map((marker) => panelHtml.indexOf(marker));
  assert.ok(positions.every((at) => at >= 0), `every marker is present: ${JSON.stringify(Object.fromEntries(order.map((m, i) => [m, positions[i]])))}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'markup order');
  assert.doesNotMatch(panelHtml.slice(panelHtml.indexOf('class="species-credit"')), /<button|<input|id="species-/, 'nothing after the credit line');
  assert.match(css, /#left-panel-stack > #species-panel \{[^}]*order: 5;/);
  assert.match(css, /body\.cockpit-mode #left-panel-stack > #species-panel \{ display: none !important; \}/);
  assert.match(css, /#species-panel\.collapsed \.species-body \{ display: none !important; \}/);
  assert.match(css, /\.species-suggestions\[hidden\] \{ display: none; \}/);
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
