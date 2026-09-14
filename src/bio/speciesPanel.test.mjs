// src/bio/speciesPanel.test.mjs — choosing a species, suggestion text, and the markup / CSS / startup wiring pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpeciesPanel, suggestionText } from './speciesPanel.js';
import { SPECIES_MAP_LEGEND, gbifPortalTaxonUrl, yearLabel } from './gbif.js';
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

const PANEL_IDS = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-chosen-name', 'species-toggle', 'species-legend', 'species-datasets', 'species-years', 'species-radius', 'species-what-lives-here'];
const INAT_RG = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';
const OTHER_DATASET = '6ac3f774-d9fb-4796-b3e9-92bf6c81c084';
const settle = async (turns = 20) => { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const MONARCH = { gbifKey: 5133088, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' };
const yearsChip = (years) => ({ target: { closest: () => ({ dataset: { years } }) } });
// The rows under "Top datasets": [link href, link text, count, note or null].
const datasetRowsIn = (box) => box.children[0].children[1].children.map((li) => [li.children[0].href, li.children[0].textContent, li.children[1].textContent, li.children[2]?.textContent ?? null]);

function panelRig({ match = async () => 5133088, suggest = async () => ({ source: 'none', items: [] }), setTimer = () => 0, enabled: initiallyEnabled = false, taxonDatasets = null, dataset = null } = {}) {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, fakeElement()]));
  const doc = { getElementById: (id) => els[id] || null, createElement: (tag) => Object.assign(fakeElement(), { tag }) };
  let params = { taxonKey: null, name: null, years: 'recent', radiusKm: 10 };
  let enabled = initiallyEnabled;
  const calls = { params: [], enable: [], match: [], taxonDatasets: [], dataset: [] };
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
    taxonDatasets: async (args, options) => {
      calls.taxonDatasets.push({ args, signal: options?.signal });
      if (taxonDatasets) return taxonDatasets(args, options);
      return { total: 42534, datasets: [{ key: INAT_RG, count: 41111 }, { key: OTHER_DATASET, count: 306 }] };
    },
    dataset: async (key, options) => {
      calls.dataset.push(key);
      if (dataset) return dataset(key, options);
      return key === INAT_RG ? { key, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' } : { key, title: 'Dataset without a DOI', doi: null };
    },
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
  // A switch: aria-checked carries the state; its accessible name stays "Species map" (index.html) while the words change.
  assert.equal(els['species-toggle'].attrs['aria-checked'], 'true');
  assert.equal(Object.hasOwn(els['species-toggle'].attrs, 'aria-pressed'), false, 'a switch carries aria-checked, not aria-pressed');
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

// R-7t: GBIF draws each cell as a circle sized, filled and faded by its record count, so the legend names each class: a circle at the
// class's style width in CSS px, in its fill and opacity, with its line where the style draws one (aria-hidden), and its upper bound as
// text, under a caption. All of it comes from SPECIES_MAP_LEGEND, which gbif.test.mjs pins to the tile style.
test('the legend shows each GBIF record-count class as a circle in its style size, fill, opacity and line, with its upper bound as text', () => {
  const { els } = panelRig();
  const legend = els['species-legend'];
  assert.equal(legend.children.length, 2, 'a caption and the class list');
  const [caption, list] = legend.children;
  assert.equal(caption.textContent, 'records per circle');
  assert.ok(caption.id, 'the caption has an id');
  assert.equal(list.tag, 'ol');
  assert.equal(list.attrs['aria-labelledby'], caption.id, 'the caption labels the list');
  assert.equal(list.children.length, SPECIES_MAP_LEGEND.classes.length);
  const part = (item, className) => item.children.find((child) => child.className === className);
  const swatches = list.children.map((item) => part(item, 'species-legend-swatch'));
  const labels = list.children.map((item) => part(item, 'species-legend-label'));
  assert.deepEqual(swatches.map(({ style }) => [style.width, style.height, style.backgroundColor, style.opacity, style.border]), [
    ['6px', '6px', '#fed976', '1', '1px solid #fe9724'],
    ['7px', '7px', '#fd8d3c', '0.8', 'none'],
    ['10px', '10px', '#fd8d3c', '0.7', 'none'],
    ['16px', '16px', '#f03b20', '0.6', 'none'],
    ['30px', '30px', '#bd0026', '0.6', 'none'],
  ]);
  assert.ok(swatches.every((swatch) => swatch.attrs['aria-hidden'] === 'true' && swatch.textContent === ''), 'swatches are decoration only');
  assert.deepEqual(labels.map((label) => label.textContent), ['≤10', '≤100', '≤1k', '≤10k', '>10k']);
  assert.ok(labels.every((label) => label.attrs['aria-hidden'] === undefined), 'the labels are read out');
});

test('the colour legend shows only while the map of a chosen species is on', async () => {
  // The legend sits below the action, outside the chosen-species block, so it cannot inherit that block's hidden state.
  assert.equal(panelRig({ enabled: true }).els['species-legend'].hidden, true, 'map on with no species chosen');
  const { panel, els } = panelRig();
  assert.equal(els['species-legend'].hidden, true, 'no species chosen, map off');
  await panel.choose({ gbifKey: 5133088, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' });
  assert.equal(els['species-toggle'].textContent, 'MAP ON');
  assert.equal(els['species-legend'].hidden, false, 'map on');
  els['species-toggle'].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(els['species-toggle'].textContent, 'MAP OFF');
  assert.equal(els['species-toggle'].attrs['aria-checked'], 'false');
  assert.equal(els['species-legend'].hidden, true, 'map off again');
});

// R-7u: while the map of a chosen species is on, the panel names the top 3 datasets behind it (that taxon, the chosen years, CC0 and CC BY
// records) with DOI links, and links the same records on gbif.org. The block hides with the legend.
test('the panel lists the top datasets of the mapped taxon with a gbif.org link to its records, and hides them with the legend', async () => {
  const { panel, els, calls } = panelRig();
  const box = els['species-datasets'];
  assert.equal(box.hidden, true, 'no species chosen');
  await panel.choose(MONARCH);
  await settle();
  assert.deepEqual(calls.taxonDatasets.map((c) => c.args), [{ taxonKey: 5133088, years: 'recent' }]);
  assert.deepEqual(calls.dataset, [INAT_RG, OTHER_DATASET], 'each listed dataset is looked up, in facet order');
  assert.equal(box.hidden, false);
  assert.deepEqual(box.children.map((child) => [child.tag, child.className]), [['div', 'dataset-list'], ['a', 'species-datasets-link']]);
  assert.deepEqual(datasetRowsIn(box), [
    ['https://doi.org/10.15468/ab3s5x', 'iNaturalist Research-grade Observations', '41,111', null],
    [`https://www.gbif.org/dataset/${OTHER_DATASET}`, 'Dataset without a DOI', '306', null],
  ]);
  const link = box.children[1];
  assert.deepEqual([link.href, link.target, link.rel, link.textContent], [gbifPortalTaxonUrl({ taxonKey: 5133088, years: 'recent' }), '_blank', 'noopener noreferrer', `All ${yearLabel('recent')} CC0/CC BY records on GBIF.org`]);
  panel.render();
  await settle();
  assert.equal(calls.taxonDatasets.length, 1, 'a render with the same taxon and years sends nothing new');
  els['species-toggle'].listeners.click();
  await settle();
  assert.equal(els['species-legend'].hidden, true);
  assert.equal(box.hidden, true, 'map off hides the datasets with the legend');
  assert.equal(calls.taxonDatasets.length, 1);
});

test('new years or a new taxon abort the stale dataset search, and its late answer is never shown', async () => {
  // A client that answers even after its signal aborted: the panel itself must drop the stale answer.
  const pending = [];
  const { panel, els } = panelRig({ taxonDatasets: (args, { signal }) => new Promise((resolve) => { pending.push({ args, signal, resolve }); }) });
  const box = els['species-datasets'];
  await panel.choose(MONARCH);
  await settle();
  assert.deepEqual(pending.map((p) => p.args), [{ taxonKey: 5133088, years: 'recent' }]);
  els['species-years'].listeners.click(yearsChip('all'));
  await settle();
  assert.deepEqual(pending.map((p) => [p.args, p.signal.aborted]), [[{ taxonKey: 5133088, years: 'recent' }, true], [{ taxonKey: 5133088, years: 'all' }, false]]);
  pending[1].resolve({ total: 306, datasets: [{ key: OTHER_DATASET, count: 306 }] });
  pending[0].resolve({ total: 41111, datasets: [{ key: INAT_RG, count: 41111 }] });
  await settle();
  assert.deepEqual(datasetRowsIn(box).map((row) => row[1]), ['Dataset without a DOI'], 'the answer for the current years only');
  assert.equal(box.children[1].href, gbifPortalTaxonUrl({ taxonKey: 5133088, years: 'all' }));
  await panel.chooseTaxon({ taxonKey: 5220086, name: 'Humpback Whale' });
  await settle();
  assert.deepEqual(pending[2].args, { taxonKey: 5220086, years: 'all' });
  els['species-years'].listeners.click(yearsChip('recent'));
  await settle();
  assert.equal(pending[2].signal.aborted, true, 'a change while a search is in flight aborts it');
  pending[2].resolve({ total: 1, datasets: [{ key: INAT_RG, count: 1 }] });
  await settle();
  assert.notEqual(box.children[1]?.href, gbifPortalTaxonUrl({ taxonKey: 5220086, years: 'all' }), 'the aborted answer is not shown');
  assert.deepEqual(pending[3].args, { taxonKey: 5220086, years: 'recent' });
});

test('a failed dataset search shows in the panel status; a failed dataset lookup is a row naming its error', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const failing = panelRig({ taxonDatasets: async () => { await settle(2); throw new Error('HTTP 503'); } });
    await failing.panel.choose(MONARCH);
    await settle();
    assert.equal(failing.els['species-status'].textContent, 'GBIF dataset search failed (HTTP 503)');
    const lookup = panelRig({ dataset: async (key) => { if (key === OTHER_DATASET) throw new Error('timeout'); return { key, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' }; } });
    await lookup.panel.choose(MONARCH);
    await settle();
    assert.deepEqual(datasetRowsIn(lookup.els['species-datasets'])[1], [`https://www.gbif.org/dataset/${OTHER_DATASET}`, `GBIF dataset ${OTHER_DATASET}`, '306', 'dataset lookup failed: timeout']);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged.map(([label]) => label), ['[species] dataset search failed', '[species] dataset lookup failed']);
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
  // The action sits directly after the chosen-species block, before the legend and the chips, so the 400x800 panel still shows it
  // whole above its cut; the credit line is last.
  const panelHtml = stack.slice(stack.indexOf('id="species-panel"'));
  // The legend's content is rendered from SPECIES_MAP_LEGEND (speciesPanel.js), so the markup holds an empty container.
  assert.match(panelHtml, /<div id="species-chosen"[^>]*>\s*<span id="species-chosen-name"[^>]*><\/span>\s*<button [^>]*id="species-toggle"[^>]*>MAP OFF<\/button>\s*<\/div>\s*<button [^>]*id="species-what-lives-here"[^>]*>WHAT LIVES HERE<\/button>\s*<div id="species-legend" class="species-legend" hidden><\/div>/);
  // The map toggle is a switch with a fixed accessible name; aria-checked carries its state.
  const toggleTag = panelHtml.match(/<button [^>]*id="species-toggle"[^>]*>/)?.[0] ?? '';
  for (const attr of ['role="switch"', 'aria-checked="false"', 'aria-label="Species map"']) assert.ok(toggleTag.includes(attr), `${attr} in ${toggleTag}`);
  assert.equal(toggleTag.includes('aria-pressed'), false, `no aria-pressed on the switch: ${toggleTag}`);
  // R-7u: the top datasets sit directly under the legend, which they hide with.
  assert.match(panelHtml, /<div id="species-legend" class="species-legend" hidden><\/div>\s*<div id="species-datasets" class="species-datasets" hidden><\/div>/);
  const order = ['id="species-search"', 'id="species-suggestions"', 'id="species-status"', 'id="species-chosen"', 'id="species-what-lives-here"', 'id="species-legend"', 'id="species-datasets"', 'id="species-years-label"', 'id="species-years"', 'id="species-radius-label"', 'id="species-radius"', 'class="species-credit"'];
  const positions = order.map((marker) => panelHtml.indexOf(marker));
  assert.ok(positions.every((at) => at >= 0), `every marker is present: ${JSON.stringify(Object.fromEntries(order.map((m, i) => [m, positions[i]])))}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'markup order');
  assert.doesNotMatch(panelHtml.slice(panelHtml.indexOf('class="species-credit"')), /<button|<input|id="species-/, 'nothing after the credit line');
  // R-7o: each chip row has a visible label directly above it that also names its group, so "1 / 10 / 50 KM" does not read as a
  // map feature size.
  for (const [group, text] of [['species-years', 'Years'], ['species-radius', 'What lives here radius']]) {
    assert.match(panelHtml, new RegExp(`<span id="${group}-label" class="species-label">${text}</span>\\s*<div id="${group}"`), `${group}: its visible label comes first`);
    const tag = panelHtml.match(new RegExp(`<div id="${group}"[^>]*>`))?.[0] ?? '';
    assert.ok(tag.includes('role="group"') && tag.includes(`aria-labelledby="${group}-label"`), `${group} is a group named by its visible label: ${tag}`);
    assert.equal(tag.includes('aria-label='), false, `${group} takes its name from the visible label only: ${tag}`);
  }
  assert.match(css, /#left-panel-stack > #species-panel \{[^}]*order: 5;/);
  assert.match(css, /body\.cockpit-mode #left-panel-stack > #species-panel \{ display: none !important; \}/);
  assert.match(css, /#species-panel\.collapsed \.species-body \{ display: none !important; \}/);
  assert.match(css, /\.species-suggestions\[hidden\] \{ display: none; \}/);
  // R-7t: swatch sizes, fills and lines come from SPECIES_MAP_LEGEND, so none is written in the CSS; the CSS makes each swatch a circle
  // whose line is inside its stated width.
  assert.doesNotMatch(css, /\.species-legend-ramp|#e4e737|#b41c5b|#fed976|#fd8d3c|#f03b20|#bd0026/i);
  assert.match(css, /\.species-legend-swatch \{[^}]*border-radius: 50%;[^}]*box-sizing: border-box;/);
  assert.doesNotMatch(css, /\.species-legend-swatch \{[^}]*(?:width|height):/);
  assert.match(css, /\.scene-btn\.species-switch\[aria-checked="true"\]::before \{/);
  assert.doesNotMatch(css, /species-switch\[aria-pressed/);
  assert.match(main, /dataManager\.register\(speciesLayer\);/);
  assert.match(main, /createDetailsCard\(\{/);
  assert.match(main, /createDetailsCard\(\{[^\n]*onDismiss: \(\) => whatLivesHere\?\.cancel\(\), onListEnd: \(\) => whatLivesHere\?\.listEnded\(\) \}\)/, 'the card ends the what-lives-here outline');
  assert.match(main, /createWhatLivesHere\(\{/);
  assert.match(main, /createSpeciesPanel\(\{/);
  const cockpit = ui.match(/const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.match(cockpit[1], /'species-panel'/);
  const credit = DATA_CREDITS.find((entry) => entry.key === 'species');
  assert.ok(credit && /GBIF\.org/.test(credit.html) && /iNaturalist/.test(credit.html) && /CC0 and CC BY/.test(credit.html));
  // R-7u: the credits say the top datasets are named with their DOIs, in the attribution lightbox and in the panel's credit line.
  assert.match(credit.html, /top datasets[^<]*DOIs/i);
  assert.match(panelHtml, /<p class="species-credit">[\s\S]*<span>Top datasets named with DOIs<\/span>[\s\S]*<\/p>/);
});
