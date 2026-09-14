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

const PANEL_IDS = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-chosen-name', 'species-toggle', 'species-legend', 'species-datasets', 'species-datasets-status', 'species-datasets-content', 'species-years', 'species-radius', 'species-what-lives-here'];
const INAT_RG = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';
const OTHER_DATASET = '6ac3f774-d9fb-4796-b3e9-92bf6c81c084';
const settle = async (turns = 20) => { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const MONARCH = { gbifKey: 5133088, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' };
const yearsChip = (years) => ({ target: { closest: () => ({ dataset: { years } }) } });
// The rows under "Top datasets" in the block's content element: [link href, link text, count, note or null].
const datasetRowsIn = (content) => content.children[0].children[1].children.map((li) => [li.children[0].href, li.children[0].textContent, li.children[1].textContent, li.children[2]?.textContent ?? null]);

function panelRig({ match = async () => 5133088, suggest = async () => ({ source: 'none', items: [] }), setTimer = () => 0, enabled: initiallyEnabled = false, taxonDatasets = null, dataset = null } = {}) {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, fakeElement()]));
  const doc = { activeElement: null, getElementById: (id) => els[id] || null, createElement: (tag) => Object.assign(fakeElement(), { tag, focus() { doc.activeElement = this; } }) };
  for (const node of Object.values(els)) node.focus = () => { doc.activeElement = node; };
  // I-2: the block holds a polite live region that exists before any message; replacing the block's children would remove it.
  els['species-datasets'].replaceChildren = () => { throw new Error('#species-datasets.replaceChildren would remove its live region'); };
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
  return { panel, els, calls, doc };
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
test('the legend shows each GBIF record-count class as a circle at its style size in its drawn colour, with its upper bound as text', () => {
  const { els } = panelRig();
  const legend = els['species-legend'];
  assert.equal(legend.children.length, 2, 'a caption and the class list');
  const [caption, list] = legend.children;
  assert.equal(caption.textContent, SPECIES_MAP_LEGEND.caption);
  assert.ok(caption.id, 'the caption has an id');
  assert.equal(list.tag, 'ol');
  assert.equal(list.attrs['aria-labelledby'], caption.id, 'the caption labels the list');
  assert.equal(list.children.length, SPECIES_MAP_LEGEND.classes.length);
  const part = (item, className) => item.children.find((child) => child.className === className);
  const swatches = list.children.map((item) => part(item, 'species-legend-swatch'));
  const labels = list.children.map((item) => part(item, 'species-legend-label'));
  // B2: a solid circle at the style width in the colour the globe draws that class (SPECIES_MAP_LEGEND.color), not the style fill at its
  // opacity, which on the dark panel showed colours the map never has.
  assert.deepEqual(swatches.map(({ style }) => [style.width, style.height, style.backgroundColor, style.opacity ?? '', style.border ?? '']), [
    ['6px', '6px', '#e4d9ac', '', ''],
    ['7px', '7px', '#d5aa78', '', ''],
    ['10px', '10px', '#cea878', '', ''],
    ['16px', '16px', '#be8770', '', ''],
    ['30px', '30px', '#ab7272', '', ''],
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
  const content = els['species-datasets-content'];
  assert.equal(box.hidden, true, 'no species chosen');
  await panel.choose(MONARCH);
  await settle();
  assert.deepEqual(calls.taxonDatasets.map((c) => c.args), [{ taxonKey: 5133088, years: 'recent' }]);
  assert.deepEqual(calls.dataset, [INAT_RG, OTHER_DATASET], 'each listed dataset is looked up, in facet order');
  assert.equal(box.hidden, false);
  assert.deepEqual(content.children.map((child) => [child.tag, child.className]), [['div', 'dataset-list'], ['a', 'species-datasets-link']]);
  assert.equal(content.children[0].children[0].textContent, 'Top datasets for this species', 'S3: the panel names whose datasets these are');
  assert.deepEqual(datasetRowsIn(content), [
    ['https://doi.org/10.15468/ab3s5x', 'iNaturalist Research-grade Observations', '41,111', null],
    [`https://www.gbif.org/dataset/${OTHER_DATASET}`, 'Dataset without a DOI', '306', null],
  ]);
  const link = content.children[1];
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
  const box = els['species-datasets-content'];
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

// I1: a failed dataset search is shown inside the Top datasets block, with Retry, not in the shared status line, where a later message wiped
// it and a later success left it standing. It hides with the block and clears when a search succeeds.
test('a failed dataset search shows in the datasets block with Retry, survives a status message, and clears on success', async () => {
  const answers = [];
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const { panel, els, calls, doc } = panelRig({ taxonDatasets: async (args) => { await settle(2); const next = answers.shift(); if (next instanceof Error) throw next; return next; } });
    const box = els['species-datasets'];
    const content = els['species-datasets-content'];
    // I-2: the failure is written into the block's own polite live region (#species-datasets-status, in index.html from page load), so a
    // screen reader announces it; Retry sits in the content.
    const announced = els['species-datasets-status'];
    const failureIn = (node) => node.children.find((child) => child.className === 'species-datasets-error') ?? null;
    answers.push(new Error('HTTP 503'));
    await panel.choose(MONARCH);
    await settle();
    assert.equal(announced.textContent, 'GBIF dataset search failed (HTTP 503)');
    const retry = failureIn(content)?.children.find((child) => child.tag === 'button');
    assert.deepEqual([retry?.tag, retry?.type, retry?.textContent], ['button', 'button', 'Retry']);
    assert.equal(/failed/.test(els['species-status'].textContent), false, 'not in the shared status line');
    els['species-status'].textContent = 'iNaturalist didn\'t answer (HTTP 500); showing GBIF scientific names';
    panel.render();
    await settle();
    assert.equal(announced.textContent, 'GBIF dataset search failed (HTTP 503)', 'a status message does not wipe it, and a render does not resend');
    assert.equal(calls.taxonDatasets.length, 1);
    answers.push({ total: 306, datasets: [{ key: OTHER_DATASET, count: 306 }] });
    doc.activeElement = retry;
    retry.listeners.click();
    // I-2: Retry replaces its own button, so keyboard focus moves to the block itself (tabindex -1 in index.html), not to the page body.
    assert.equal(doc.activeElement, box, 'focus stays in the Top datasets block after Retry');
    await settle();
    assert.equal(calls.taxonDatasets.length, 2, 'Retry sends one new search');
    assert.equal(announced.textContent, '', 'a success clears the failure');
    assert.equal(failureIn(content), null);
    assert.deepEqual(datasetRowsIn(content).map((row) => row[1]), ['Dataset without a DOI']);
    answers.push(new Error('HTTP 429'), { total: 1, datasets: [{ key: INAT_RG, count: 1 }] });
    els['species-years'].listeners.click(yearsChip('all'));
    await settle();
    assert.equal(announced.textContent, 'GBIF dataset search failed (HTTP 429)');
    els['species-years'].listeners.click(yearsChip('recent'));
    await settle();
    assert.equal(announced.textContent, '', 'a years change that succeeds shows no failure');
    assert.equal([els['species-status'].textContent, announced.textContent, ...content.children.map((child) => child.textContent)].some((text) => /failed/.test(text ?? '')), false, 'no failure text anywhere');
    els['species-toggle'].listeners.click();
    await settle();
    assert.equal(box.hidden, true, 'the block, failure or list, hides with the legend');
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged.map(([label]) => label), ['[species] dataset search failed', '[species] dataset search failed']);
});

// M2: both guards in showDatasets and the map-off abort, each with a client that ignores its signal, so only the panel's own checks can stop
// a stale answer.
test('an answer that lands after its search was superseded, while its dataset lookups were out, is never shown', async () => {
  const lookups = [];
  const searches = [];
  const { panel, els } = panelRig({
    taxonDatasets: (args) => new Promise((resolve) => { searches.push({ args, resolve }); }),
    dataset: (key) => new Promise((resolve) => { lookups.push({ key, resolve }); }),
  });
  const box = els['species-datasets-content'];
  await panel.choose(MONARCH);
  await settle();
  searches[0].resolve({ total: 41111, datasets: [{ key: INAT_RG, count: 41111 }] });
  await settle();
  assert.equal(lookups.length, 1, 'the first search is past its facet answer and waiting on its dataset lookup');
  els['species-years'].listeners.click(yearsChip('all'));
  await settle();
  assert.equal(searches.length, 2, 'the years change sent a new search');
  lookups[0].resolve({ key: INAT_RG, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' });
  await settle();
  assert.deepEqual(box.children.map((child) => child.className), ['species-datasets-loading'], 'the superseded answer is dropped; the new search is still loading');
});

test('turning the map off while a dataset search is out aborts it and empties the hidden block', async () => {
  const searches = [];
  const { panel, els } = panelRig({ taxonDatasets: (args, { signal }) => new Promise((resolve) => { searches.push({ args, signal, resolve }); }) });
  const box = els['species-datasets-content'];
  await panel.choose(MONARCH);
  await settle();
  assert.equal(searches.length, 1);
  els['species-toggle'].listeners.click();
  await settle();
  assert.equal(els['species-datasets'].hidden, true);
  assert.equal(searches[0].signal.aborted, true, 'map off aborts the search in flight');
  searches[0].resolve({ total: 1, datasets: [{ key: INAT_RG, count: 1 }] });
  await settle();
  assert.equal(box.children.length, 0, 'nothing fills the hidden block');
});

// M-1: a failed search is searched again when the map returns; a finished list is kept (positive control in the same test).
test('after a failed dataset search, turning the map off and on searches again once and clears the failure; a finished list is kept', async () => {
  const answers = [new Error('HTTP 503'), { total: 306, datasets: [{ key: OTHER_DATASET, count: 306 }] }];
  const original = console.error;
  console.error = () => {};
  try {
    const { panel, els, calls } = panelRig({ taxonDatasets: async () => { await settle(2); const next = answers.shift(); if (next instanceof Error) throw next; return next; } });
    const toggle = async () => { els['species-toggle'].listeners.click(); await settle(); };
    await panel.choose(MONARCH);
    await settle();
    assert.equal(els['species-datasets-status'].textContent, 'GBIF dataset search failed (HTTP 503)');
    await toggle();
    await toggle();
    assert.equal(calls.taxonDatasets.length, 2, 'exactly one new search when the map returns after a failure');
    assert.equal(els['species-datasets-status'].textContent, '', 'and the failure is gone');
    assert.deepEqual(datasetRowsIn(els['species-datasets-content']).map((row) => row[1]), ['Dataset without a DOI']);
    await toggle();
    await toggle();
    assert.equal(calls.taxonDatasets.length, 2, 'positive control: a finished list is kept, with no new search');
  } finally {
    console.error = original;
  }
});

test('a failed dataset lookup is a row naming its error', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const lookup = panelRig({ dataset: async (key) => { if (key === OTHER_DATASET) throw new Error('timeout'); return { key, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' }; } });
    await lookup.panel.choose(MONARCH);
    await settle();
    assert.deepEqual(datasetRowsIn(lookup.els['species-datasets-content'])[1], [`https://www.gbif.org/dataset/${OTHER_DATASET}`, `GBIF dataset ${OTHER_DATASET}`, '306', 'dataset lookup failed: timeout']);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged.map(([label]) => label), ['[species] dataset lookup failed']);
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
  // B1/S1: the action sits directly after the chosen-species block and the two chip rows follow it, each label beside its row in a group,
  // so the controls stay whole above the panel's cut on a 400x800 phone; the legend, the datasets and the credit line come after them.
  const panelHtml = stack.slice(stack.indexOf('id="species-panel"'));
  // The legend's content is rendered from SPECIES_MAP_LEGEND (speciesPanel.js), so the markup holds an empty container.
  assert.match(panelHtml, /<div id="species-chosen"[^>]*>\s*<span id="species-chosen-name"[^>]*><\/span>\s*<button [^>]*id="species-toggle"[^>]*>MAP OFF<\/button>\s*<\/div>\s*<button [^>]*id="species-what-lives-here"[^>]*>WHAT LIVES HERE<\/button>\s*<div class="species-chip-group">\s*<span id="species-years-label"/);
  assert.match(panelHtml, /<div class="species-chip-group">\s*<span id="species-radius-label"[^>]*>[^<]*<\/span>\s*<div id="species-radius"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<div id="species-legend" class="species-legend" hidden><\/div>/);
  // The map toggle is a switch with a fixed accessible name; aria-checked carries its state.
  const toggleTag = panelHtml.match(/<button [^>]*id="species-toggle"[^>]*>/)?.[0] ?? '';
  for (const attr of ['role="switch"', 'aria-checked="false"', 'aria-label="Species map"']) assert.ok(toggleTag.includes(attr), `${attr} in ${toggleTag}`);
  assert.equal(toggleTag.includes('aria-pressed'), false, `no aria-pressed on the switch: ${toggleTag}`);
  // R-7u: the top datasets sit directly under the legend, which they hide with.
  // I-2: the Top datasets block can take focus (Retry moves focus to it) and holds a polite live region from page load, then its content.
  assert.match(panelHtml, /<div id="species-legend" class="species-legend" hidden><\/div>\s*<div id="species-datasets" class="species-datasets" tabindex="-1" hidden>\s*<p id="species-datasets-status" class="species-datasets-status" role="status" aria-live="polite"><\/p>\s*<div id="species-datasets-content" class="species-datasets-content"><\/div>\s*<\/div>/);
  const order = ['id="species-search"', 'id="species-suggestions"', 'id="species-status"', 'id="species-chosen"', 'id="species-what-lives-here"', 'id="species-years-label"', 'id="species-years"', 'id="species-radius-label"', 'id="species-radius"', 'id="species-legend"', 'id="species-datasets"', 'class="species-credit"'];
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
  // R-7s: the row labels (Find a species, Years, What lives here radius) measured 4.00 to 4.55:1 in the shared 0.5 white, so they use the
  // chips' 0.8 white.
  assert.match(css, /\.species-label \{[^}]*color: rgba\(232, 234, 237, 0\.8\);/);
  assert.doesNotMatch(css, /\.species-label \{[^}]*var\(--text-secondary\)/);
  // S4: the search placeholder is 0.65 white (the browser default measured 3.55:1), and the native clear button is replaced by a light
  // cross that measures at least 3:1, keeping the native control and its keyboard behaviour.
  assert.match(css, /#species-search::placeholder \{ color: rgba\(232, 234, 237, 0\.65\); \}/);
  assert.match(css, /#species-search::-webkit-search-cancel-button \{[^}]*-webkit-appearance: none;[^}]*background: url\("data:image\/svg\+xml,[^"]*stroke='%23e8eaed'[^"]*"\)/);
  assert.match(css, /#left-panel-stack > #species-panel \{[^}]*order: 5;/);
  assert.match(css, /body\.cockpit-mode #left-panel-stack > #species-panel \{ display: none !important; \}/);
  assert.match(css, /#species-panel\.collapsed \.species-body \{ display: none !important; \}/);
  // B1/S1: the body scrolls under a fixed header and fades out at its bottom while more is below; the legend has an opaque ground, so a
  // swatch cut by the panel's edge can never sit on the globe; on narrow screens the controls tighten so the action and both chip rows fit.
  assert.match(css, /#left-panel-stack > #species-panel:not\(\.collapsed\) \.species-panel-inner \{[^}]*overflow: hidden;/);
  assert.match(css, /#left-panel-stack > #species-panel:not\(\.collapsed\) \.species-body \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /@property --species-body-fade \{[^}]*initial-value: 0px;/);
  assert.match(css, /@supports \(animation-timeline: scroll\(\)\) \{\s*#species-panel \.species-body \{[^}]*mask-image: linear-gradient\(to bottom, #000 calc\(100% - var\(--species-body-fade\)\), transparent\);[^}]*animation: species-body-fade linear both, species-more linear both;[^}]*animation-timeline: scroll\(self\), scroll\(self\);/);
  // N4: on wider screens a "more ↓" hint sits at the body's bottom edge while more is below and fades out at the end, driven by the same
  // scroll timeline (0 when nothing scrolls). Nit: the Top datasets heading sticks to the top of the body while its list is in view.
  assert.match(css, /@property --species-more \{[^}]*inherits: true;[^}]*initial-value: 0;/);
  assert.match(css, /@media \(min-width: 721px\) \{\s*@supports \(animation-timeline: scroll\(\)\) \{\s*#species-panel \.species-body::after \{[^}]*content: "more ↓" \/ "";[^}]*position: sticky;[^}]*bottom: 0;[^}]*opacity: var\(--species-more\);/);
  assert.match(css, /#species-datasets \.dataset-list-heading \{[^}]*position: sticky;[^}]*top: 0;[^}]*background: rgb\(13, 15, 22\);/);
  assert.match(css, /\.species-legend \{[^}]*background: rgb\(13, 15, 22\);/);
  assert.match(css, /\.species-chip-group \{ display: flex; flex-wrap: wrap;/);
  // In a group the chips take their text's width: the shared .scene-btn flex: 1 squeezed LAST 10 YEARS below its text on the desktop panel.
  assert.match(css, /\.species-chip-group \.scene-btn\.species-chip \{ flex: 0 0 auto; \}/);
  assert.match(css, /@media \(max-width: 720px\) \{[^@]*#species-panel \.scene-btn\.species-chip \{[^}]*min-width: 0;/);
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
  // M4: a dataset links its DOI where GBIF has one and its gbif.org page otherwise, and the credits say exactly that, in the attribution
  // lightbox and in the panel's credit line.
  assert.match(credit.html, /the top datasets behind each list and map are named with a DOI link where GBIF has one, and a gbif\.org dataset page otherwise\./);
  assert.match(panelHtml, /<p class="species-credit">[\s\S]*<span>Top datasets: a DOI link where GBIF has one,<\/span> <span>otherwise a gbif\.org dataset page<\/span><\/p>/);
  assert.doesNotMatch(html + credit.html, /named with (their )?DOIs/);
});
