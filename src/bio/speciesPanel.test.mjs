// src/bio/speciesPanel.test.mjs — choosing a species, suggestion text, and the markup / CSS / startup wiring pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpeciesPanel, hasMoreBelow, MORE_SLACK_PX, suggestionText } from './speciesPanel.js';
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

const PANEL_IDS = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-chosen-name', 'species-chosen-note', 'species-toggle', 'species-legend', 'species-datasets', 'species-datasets-heading', 'species-datasets-status', 'species-datasets-content', 'species-years', 'species-radius', 'species-what-lives-here', 'species-body', 'species-more'];
const INAT_RG = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';
const OTHER_DATASET = '6ac3f774-d9fb-4796-b3e9-92bf6c81c084';
const settle = async (turns = 20) => { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const MONARCH = { gbifKey: 5133088, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' };
const yearsChip = (years) => ({ target: { closest: () => ({ dataset: { years } }) } });
// The rows in the block's content element, a list labelled by the block's heading in index.html: [link href, link text, count, note or null].
const datasetRowsIn = (content) => content.children[0].children.map((li) => [li.children[0].href, li.children[0].textContent, li.children[1].textContent, li.children[2]?.textContent ?? null]);

function panelRig({ match = async () => ({ key: 5133088, matchType: 'EXACT', canonicalName: 'Danaus plexippus' }), speciesName = async (key) => ({ key, scientificName: 'x', commonName: null }), suggest = async () => ({ source: 'none', items: [] }), setTimer = () => 0, clearTimer = () => {}, enabled: initiallyEnabled = false, taxonDatasets = null, dataset = null } = {}) {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, fakeElement()]));
  const doc = { activeElement: null, getElementById: (id) => els[id] || null, createElement: (tag) => Object.assign(fakeElement(), { tag, focus() { doc.activeElement = this; } }) };
  for (const node of Object.values(els)) node.focus = () => { doc.activeElement = node; };
  // I-2: the block holds a polite live region that exists before any message; replacing the block's children would remove it.
  els['species-datasets'].replaceChildren = () => { throw new Error('#species-datasets.replaceChildren would remove its live region'); };
  Object.assign(els['species-body'], { scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  // The body's content, as its direct children in index.html (the chip groups and the credit line have no id here).
  els['species-body'].children = ['species-search', 'species-suggestions', 'species-status', 'species-chosen', 'species-what-lives-here', 'species-legend', 'species-datasets'].map((id) => els[id]);
  let params = { taxonKey: null, name: null, years: 'recent', radiusKm: 10 };
  let enabled = initiallyEnabled;
  const calls = { params: [], enable: [], match: [], speciesName: [], taxonDatasets: [], dataset: [] };
  // Like src/data/manager.js, subscribers hear 'params-requested' before the layer applies new params (_reserveLayerParamsIntent) and 'params'
  // after, so a render during the request sees the previous params. A fake that never notified hid that the FUZZY note was lost (M1).
  const listeners = [];
  const notify = (change) => { for (const listener of listeners) listener(change); };
  const dataManager = {
    getLayerParams: () => ({ ...params }),
    setLayerParams: (id, p, options) => {
      calls.params.push({ id, p, origin: options.origin });
      notify({ type: 'params-requested', layerId: id, params: { ...p }, origin: options.origin });
      params = { ...params, ...p };
      notify({ type: 'params', layerId: id, params: { ...params }, origin: options.origin });
      return true;
    },
    isEnabled: () => enabled,
    setEnabled: async (id, on, options) => { calls.enable.push({ id, on, origin: options.origin }); enabled = on; return true; },
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
  };
  const speciesLayer = { getStats: () => ({ error: null, tileFailures: 0 }), onStatus: () => () => {} };
  const client = {
    match: async (name, options) => { calls.match.push(name); return match(name, options); },
    speciesName: async (key, options) => { calls.speciesName.push({ key, signal: options?.signal ?? null }); return speciesName(key, options); },
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
  const resizes = [];
  const panel = createSpeciesPanel({ doc, dataManager, speciesLayer, client, whatLivesHere, setTimer, clearTimer, observeSize: (targets, onChange) => { resizes.push({ targets, onChange }); } });
  return { panel, els, calls, doc, resizes, dataManager };
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

  const missing = panelRig({ match: async () => ({ key: null, matchType: 'NONE', canonicalName: null }) });
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

// M1 (final review): a strict GBIF match can answer FUZZY (live 2026-09-14: "Danaus plexippa" → 5133088 Danaus plexippus, confidence 97), and
// the map then shows another name's records under the chosen label. So a match that is not EXACT is mapped and the chosen row and the status
// say it is shown as GBIF's name; an EXACT match says nothing; NONE maps nothing; choosing the same taxon exactly clears the note.
test("a FUZZY match is mapped and says it is shown as GBIF's name; EXACT says nothing; NONE maps nothing", async () => {
  const fuzzy = panelRig({ match: async () => ({ key: 5133088, matchType: 'FUZZY', canonicalName: 'Danaus plexippus' }) });
  assert.equal(await fuzzy.panel.choose({ gbifKey: null, scientificName: 'Danaus plexippa', commonName: 'Monarch', rank: 'species' }), true);
  assert.deepEqual(fuzzy.calls.params.at(-1), { id: 'species', p: { taxonKey: 5133088, name: 'Monarch' }, origin: 'user' }, 'the match key is mapped');
  assert.equal(fuzzy.els['species-chosen-name'].textContent, 'Monarch');
  assert.equal(fuzzy.els['species-chosen-note'].hidden, false);
  assert.equal(fuzzy.els['species-chosen-note'].textContent, "shown as GBIF's Danaus plexippus");
  assert.equal(fuzzy.els['species-status'].textContent, "No exact GBIF match for Danaus plexippa; shown as GBIF's Danaus plexippus.");
  await fuzzy.panel.chooseTaxon({ taxonKey: 5133088, name: 'Monarch' }); // a what-lives-here row: an exact GBIF key
  assert.equal(fuzzy.els['species-chosen-note'].hidden, true, 'choosing the taxon exactly clears the note');
  assert.equal(fuzzy.els['species-chosen-note'].textContent, '');

  const exact = panelRig();
  assert.equal(await exact.panel.choose({ gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' }), true);
  assert.equal(exact.calls.params.at(-1).p.taxonKey, 5133088);
  assert.equal(exact.els['species-chosen-note'].hidden, true, 'an EXACT match has no note');
  assert.equal(exact.els['species-status'].textContent, '');

  const none = panelRig({ match: async () => ({ key: null, matchType: 'NONE', canonicalName: null }) });
  assert.equal(await none.panel.choose({ gbifKey: null, scientificName: 'Danaus fakeus', commonName: null, rank: 'species' }), false);
  assert.equal(none.els['species-status'].textContent, 'Danaus fakeus is not in GBIF.');
  assert.equal(none.calls.params.length, 0, 'NONE maps nothing');
  assert.equal(none.els['species-chosen-note'].hidden, true);
});

// R13-M3: the accepted name of a synonym is looked up only where it is shown: a match that is not EXACT. An EXACT synonym maps its accepted key
// with no lookup, so a failing lookup cannot stop it (live: "Felis concolor coryi", EXACT SUBSPECIES synonym of 6164590, no subspecies field).
// A FUZZY synonym is named by the lookup, which carries the choice's signal; a lookup that fails maps nothing and says so.
test('a synonym is named by a lookup only when the match is not EXACT, and a failed lookup fails loud', async () => {
  const failing = async () => { throw new Error('HTTP 503'); };
  const exact = panelRig({ match: async () => ({ key: 6164590, matchType: 'EXACT', canonicalName: null }), speciesName: failing });
  assert.equal(await exact.panel.choose({ gbifKey: null, scientificName: 'Felis concolor coryi', commonName: 'Florida Panther', rank: 'subspecies' }), true);
  assert.deepEqual(exact.calls.params.at(-1).p, { taxonKey: 6164590, name: 'Florida Panther' }, 'the EXACT synonym maps its accepted key');
  assert.deepEqual(exact.calls.speciesName, [], 'with no lookup');
  assert.equal(exact.els['species-chosen-note'].hidden, true);

  const fuzzy = panelRig({ match: async () => ({ key: 5220086, matchType: 'FUZZY', canonicalName: null }), speciesName: async (key) => ({ key, scientificName: 'Megaptera novaeangliae', commonName: 'Humpback Whale' }) });
  assert.equal(await fuzzy.panel.choose({ gbifKey: null, scientificName: 'Megaptera nodosus', commonName: null, rank: 'species' }), true);
  assert.deepEqual(fuzzy.calls.speciesName.map((c) => c.key), [5220086], 'a FUZZY synonym looks its accepted key up');
  assert.ok(fuzzy.calls.speciesName[0].signal instanceof AbortSignal, "with the choice's signal");
  assert.equal(fuzzy.els['species-chosen-note'].textContent, "shown as GBIF's Megaptera novaeangliae");

  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const failed = panelRig({ match: async () => ({ key: 5220086, matchType: 'FUZZY', canonicalName: null }), speciesName: failing });
    assert.equal(await failed.panel.choose({ gbifKey: null, scientificName: 'Megaptera nodosus', commonName: null, rank: 'species' }), false);
    assert.equal(failed.els['species-status'].textContent, 'GBIF lookup failed (HTTP 503)');
    assert.equal(failed.calls.params.length, 0, 'a FUZZY match that cannot be named maps nothing');
    assert.equal(logged.length, 1, 'and is logged');
  } finally {
    console.error = original;
  }
});

// R13-M4: every entry point that sets the taxon starts a new choice. A suggestion choice still matching ("Megaptera nodosus") must not
// overwrite a what-lives-here pick (chooseTaxon) made while it was out, even when its match answers after all, and its "Looking up" line goes.
test('a what-lives-here pick supersedes a suggestion choice still matching, whose late answer maps nothing', async () => {
  let answer = null;
  const { panel, els, calls } = panelRig({ match: () => new Promise((resolve) => { answer = resolve; }) });
  const pending = panel.choose({ gbifKey: null, scientificName: 'Megaptera nodosus', commonName: null, rank: 'species' });
  await settle();
  assert.equal(els['species-status'].textContent, 'Looking up Megaptera nodosus in GBIF…');
  assert.equal(await panel.chooseTaxon({ taxonKey: 1340481, name: 'Nudibranch' }), true);
  answer({ key: 5220086, matchType: 'FUZZY', canonicalName: 'Megaptera novaeangliae' });
  assert.equal(await pending, false, 'the superseded choice reports that it mapped nothing');
  assert.deepEqual(calls.params.at(-1).p, { taxonKey: 1340481, name: 'Nudibranch' }, 'the newer pick stays mapped');
  assert.equal(calls.params.filter((c) => c.p.taxonKey === 5220086).length, 0, 'the late match maps nothing');
  assert.equal(els['species-chosen-note'].hidden, true, "no \"shown as GBIF's\" note for a taxon that is not mapped");
  assert.equal(els['species-status'].textContent, '', 'the superseded "Looking up" line goes');
});

// R13-M4: the accepted-name lookup carries the choice's signal, so a superseded choice ends while the lookup is still out (like the real
// client's speciesName, the fake rejects only when its caller's signal aborts). Without the signal the old choice would wait on the lookup.
test("a superseded choice ends at once while its synonym lookup is still out, because the lookup carries the choice's signal", async () => {
  const { panel, calls } = panelRig({
    match: async () => ({ key: 5220086, matchType: 'FUZZY', canonicalName: null }),
    speciesName: (key, options) => new Promise((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    }),
  });
  let result = 'pending';
  void panel.choose({ gbifKey: null, scientificName: 'Megaptera nodosus', commonName: null, rank: 'species' }).then((value) => { result = value; });
  await settle();
  assert.deepEqual(calls.speciesName.map((c) => c.key), [5220086], 'the lookup is out');
  await panel.chooseTaxon({ taxonKey: 1340481, name: 'Nudibranch' });
  await settle();
  assert.equal(calls.speciesName[0].signal?.aborted, true, 'the newer pick aborts the lookup');
  assert.equal(result, false, 'and the superseded choice has ended without mapping');
  assert.deepEqual(calls.params.at(-1).p, { taxonKey: 1340481, name: 'Nudibranch' });
});

// M2 (final review), R12-M2 (re-review): Escape in the search box does one thing at a time and marks it handled (a recorded keydown), so the
// details card and WHAT LIVES HERE, which listen on the document after it, leave that key alone. With a list showing it hides the list and keeps
// the text; with text and no list it clears the text; either way it ends the name search. With neither, Escape is theirs.
test('Escape hides a visible list, then clears the text, each marked handled and ending the search; with neither it is left unhandled', async () => {
  const timers = fakeTimers();
  const { els } = panelRig({ suggest: async () => ({ source: 'inaturalist', items: [MONARCH] }), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const input = els['species-search'];
  input.value = 'monarch';
  input.listeners.input();
  timers.fireAll();
  await settle();
  assert.equal(els['species-suggestions'].hidden, false, 'the list shows');
  const keydown = (key) => ({ key, defaultPrevented: false, prevented: 0, preventDefault() { this.defaultPrevented = true; this.prevented += 1; } });
  const first = keydown('Escape');
  input.listeners.keydown(first);
  assert.equal(els['species-suggestions'].hidden, true, 'the first Escape hides the list');
  assert.equal(input.value, 'monarch', 'and keeps the text');
  assert.equal(first.prevented, 1, 'and marks the key handled');
  input.value = 'monarchs';
  input.listeners.input();
  assert.equal(timers.pending(), 1, 'a search for "monarchs" waits for the debounce');
  const second = keydown('Escape');
  input.listeners.keydown(second);
  assert.equal(input.value, '', 'with text and no list, Escape clears the text');
  assert.equal(timers.pending(), 0, 'and ends the search');
  assert.equal(second.prevented, 1, 'and marks the key handled');
  timers.fireAll();
  await settle();
  assert.equal(els['species-suggestions'].hidden, true, 'no list comes back');
  const third = keydown('Escape');
  input.listeners.keydown(third);
  assert.equal(third.prevented, 0, 'with no list and no text, Escape is left for the card and WHAT LIVES HERE');
});

// R13-M5: the search box and its suggestion list are one combobox, so Escape with focus on a suggestion (Tab from the box) is the combobox's too:
// it hides the list, returns focus to the box, keeps the text and marks the key handled, so the card and WHAT LIVES HERE leave it alone. The
// suggestion's own keys stay its own: Enter on it is not taken by the list.
test('Escape on a focused suggestion hides the list, returns focus to the box and does nothing else', async () => {
  const timers = fakeTimers();
  const { els, doc } = panelRig({ suggest: async () => ({ source: 'inaturalist', items: [MONARCH] }), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const input = els['species-search'];
  const list = els['species-suggestions'];
  input.value = 'monarch';
  input.listeners.input();
  timers.fireAll();
  await settle();
  assert.equal(list.hidden, false, 'the list shows');
  const suggestion = list.children[0].children[0];
  suggestion.focus();
  assert.equal(typeof list.listeners.keydown, 'function', 'the suggestion list handles its keys (Escape from a suggestion reaches the combobox)');
  const enter = { key: 'Enter', target: suggestion, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  list.listeners.keydown(enter);
  assert.equal(enter.defaultPrevented, false, 'Enter on a suggestion is left to the suggestion');
  const escape = { key: 'Escape', target: suggestion, defaultPrevented: false, prevented: 0, preventDefault() { this.defaultPrevented = true; this.prevented += 1; } };
  list.listeners.keydown(escape);
  assert.equal(list.hidden, true, 'Escape on a suggestion hides the list');
  assert.equal(doc.activeElement, input, 'and returns focus to the box');
  assert.equal(input.value, 'monarch', 'and keeps the text');
  assert.equal(escape.prevented, 1, 'and marks the key handled, so the card and WHAT LIVES HERE leave it alone');
  assert.equal(timers.pending(), 0);
  const next = { key: 'Escape', target: input, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  input.listeners.keydown(next);
  assert.equal(input.value, '', 'positive control: the next Escape, in the box, clears the text as before');
});

// R12-M1 (re-review): Escape that hides the list also ends the name search. The list for "mona" shows, a search for "monar" is out and one
// for "monarch" waits for the debounce: Escape clears the timer and aborts the request, or the list reopens under the card.
test('Escape that hides the suggestion list cancels the pending debounce and aborts the name search still out', async () => {
  const timers = fakeTimers();
  const sent = [];
  const { els } = panelRig({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    suggest: (q, { signal }) => new Promise((resolve, reject) => {
      sent.push({ q, signal, resolve });
      signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    }),
  });
  const input = els['species-search'];
  const list = els['species-suggestions'];
  input.value = 'mona';
  input.listeners.input();
  timers.fireAll();
  sent[0].resolve({ source: 'inaturalist', items: [MONARCH] });
  await settle();
  assert.equal(list.hidden, false, 'the list for "mona" shows');
  input.value = 'monar';
  input.listeners.input();
  timers.fireAll();
  input.value = 'monarch';
  input.listeners.input();
  assert.deepEqual(sent.map((s) => s.q), ['mona', 'monar'], 'the search for "monar" is out');
  assert.equal(timers.pending(), 1, 'the search for "monarch" waits for the debounce');
  const escape = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  input.listeners.keydown(escape);
  assert.equal(list.hidden, true, 'Escape hides the list');
  assert.equal(escape.defaultPrevented, true, 'marked handled');
  assert.equal(timers.pending(), 0, 'and clears the pending search');
  assert.equal(sent[1].signal.aborted, true, 'and aborts the search still out');
  timers.fireAll();
  sent[1].resolve({ source: 'inaturalist', items: [MONARCH] });
  await settle();
  assert.deepEqual(sent.map((s) => s.q), ['mona', 'monar'], 'no search is sent after Escape');
  assert.equal(list.hidden, true, 'no list reopens');
});

// Critic 10 N-a: a failed name search names each source's failure once, with no nested parentheses; the codes stay visible.
test('a failed name search names each failure once in the status', async () => {
  const { els } = panelRig({ suggest: async () => { throw new Error('iNaturalist HTTP 503, GBIF HTTP 503'); }, setTimer: (fn) => { fn(); return 1; } });
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    els['species-search'].value = 'monarch';
    els['species-search'].listeners.input();
    await settle();
  } finally {
    console.error = original;
  }
  assert.equal(els['species-status'].textContent, 'Name search failed: iNaturalist HTTP 503, GBIF HTTP 503');
  assert.equal(logged.length, 1, 'the failure is logged once');
});

// Critic 10 N-d: the status that says a choice is shown as GBIF's name belongs to that choice. It stayed after the taxon was replaced (a
// what-lives-here row) or cleared (a restore, or qa's own reset), describing a species no longer chosen; it now goes with the note. A change that
// keeps the taxon, and a status about something else, leave it alone.
test("the \"shown as GBIF's\" status goes when the taxon it describes is replaced or cleared, and stays while that taxon is chosen", async () => {
  const fuzzy = { match: async () => ({ key: 5133088, matchType: 'FUZZY', canonicalName: 'Danaus plexippus' }) };
  const item = { gbifKey: null, scientificName: 'Danaus plexippa', commonName: 'Monarch', rank: 'species' };
  const STATUS = "No exact GBIF match for Danaus plexippa; shown as GBIF's Danaus plexippus.";
  const replaced = panelRig(fuzzy);
  await replaced.panel.choose(item);
  assert.equal(replaced.els['species-status'].textContent, STATUS);
  replaced.dataManager.setLayerParams('species', { years: 'all' }, { origin: 'user' });
  assert.equal(replaced.els['species-status'].textContent, STATUS, 'a change that keeps the taxon keeps the status');
  await replaced.panel.chooseTaxon({ taxonKey: 1340481, name: 'Rusty-patched Bumble Bee' });
  assert.equal(replaced.els['species-status'].textContent, '', 'another taxon chosen: the status goes');
  const cleared = panelRig(fuzzy);
  await cleared.panel.choose(item);
  cleared.dataManager.setLayerParams('species', { taxonKey: null }, { origin: 'programmatic' });
  assert.equal(cleared.els['species-status'].textContent, '', 'the taxon cleared: the status goes');
  const other = panelRig(fuzzy);
  await other.panel.choose(item);
  other.els['species-status'].textContent = 'GBIF name lookup failed (HTTP 503)';
  other.dataManager.setLayerParams('species', { taxonKey: null }, { origin: 'programmatic' });
  assert.equal(other.els['species-status'].textContent, 'GBIF name lookup failed (HTTP 503)', 'a status about something else stays');
});

// Injected timers for the suggestion debounce: scheduled callbacks run only when the test fires them.
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimer: (fn) => { const id = next; next += 1; pending.set(id, fn); return id; },
    clearTimer: (id) => { pending.delete(id); },
    pending: () => pending.size,
    fireAll: () => { const due = [...pending.values()]; pending.clear(); for (const fn of due) fn(); },
  };
}

// M3 (final review): choosing ends the name search. "mona" was sent and is still out; "monarch" is typed and a suggestion chosen within the
// 300 ms debounce, while its GBIF match is looked up. The pending debounce must not send another search, and the old answer must not reopen
// the list under the choice.
test('choosing a suggestion cancels the pending debounce and aborts the name search still out, so no list reopens under the choice', async () => {
  const timers = fakeTimers();
  const sent = [];
  let finishMatch = null;
  const { panel, els } = panelRig({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    suggest: (q, { signal }) => new Promise((resolve, reject) => {
      sent.push({ q, signal, resolve });
      signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    }),
    match: () => new Promise((resolve) => { finishMatch = resolve; }),
  });
  const input = els['species-search'];
  input.value = 'mona';
  input.listeners.input();
  timers.fireAll();
  assert.deepEqual(sent.map((s) => s.q), ['mona'], 'the first search is out');
  input.value = 'monarch';
  input.listeners.input();
  assert.equal(timers.pending(), 1, 'the next search waits for the debounce');
  const choosing = panel.choose({ gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' });
  assert.equal(timers.pending(), 0, 'the choice clears the pending search');
  assert.equal(sent[0].signal.aborted, true, 'and aborts the search still out');
  timers.fireAll();
  sent[0].resolve({ source: 'inaturalist', items: [MONARCH] });
  await settle();
  assert.deepEqual(sent.map((s) => s.q), ['mona'], 'no search is sent while the choice is looked up');
  assert.equal(els['species-suggestions'].hidden, true, 'no list reopens under the choice');
  finishMatch({ key: 5133088, matchType: 'EXACT', canonicalName: 'Danaus plexippus' });
  assert.equal(await choosing, true);
});

// M3: Enter picks the first suggestion only from a list built for what the box holds now. A list for "mona" is showing when "monarch" is typed
// and Enter pressed before its search runs: nothing is chosen. Positive control: once the list for "monarch" shows, Enter chooses its first row.
test('Enter chooses only from a suggestion list built for the query in the box', async () => {
  const timers = fakeTimers();
  const rows = {
    mona: [{ gbifKey: null, scientificName: 'Monarda fistulosa', commonName: 'Wild Bergamot', rank: 'species' }],
    monarch: [{ gbifKey: null, scientificName: 'Danaus plexippus', commonName: 'Monarch', rank: 'species' }],
  };
  const { els, calls } = panelRig({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, suggest: async (q) => ({ source: 'inaturalist', items: rows[q] }) });
  const list = els['species-suggestions'];
  // The fake list finds its first row's button like the real one, and clicking it runs the row's listener.
  list.querySelector = (selector) => { const button = selector === 'button' ? list.children[0]?.children[0] : null; return button ? { click: () => button.listeners.click() } : null; };
  const input = els['species-search'];
  input.value = 'mona';
  input.listeners.input();
  timers.fireAll();
  await settle();
  assert.equal(list.hidden, false, 'the list for "mona" shows');
  input.value = 'monarch';
  input.listeners.input();
  input.listeners.keydown({ key: 'Enter' });
  await settle();
  assert.deepEqual(calls.match, [], 'Enter does not choose from the list built for "mona"');
  timers.fireAll();
  await settle();
  input.listeners.keydown({ key: 'Enter' });
  await settle();
  assert.deepEqual(calls.match, ['Danaus plexippus'], 'positive control: Enter chooses from the list built for "monarch"');
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
    ['16px', '16px', '#be7861', '', ''],
    ['30px', '30px', '#ad5466', '', ''],
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
  // S5: the heading "Top datasets for this species" is in index.html (#species-datasets-heading), so it stays in every state; the rows are a
  // list it labels.
  assert.deepEqual(content.children.map((child) => [child.tag, child.className]), [['ol', 'dataset-list-rows'], ['a', 'species-datasets-link']]);
  assert.equal(content.children[0].attrs['aria-labelledby'], 'species-datasets-heading');
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
    // S1: Retry is the panel's cyan action button. S5: only the rows are replaced; the link to the taxon's records on gbif.org stays.
    assert.match(retry.className, /\bscene-btn\b/);
    assert.match(retry.className, /\bspecies-action\b/);
    assert.deepEqual(content.children.map((child) => child.className), ['species-datasets-error', 'species-datasets-link']);
    assert.equal(content.children[1].href, gbifPortalTaxonUrl({ taxonKey: 5133088, years: 'recent' }));
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
  assert.deepEqual(box.children.map((child) => child.className), ['species-datasets-loading', 'species-datasets-link'], 'the superseded answer is dropped; the new search is still loading');
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

// B1: the scroll cue is a row of its own below the scrolling body. It shows while more of the body is below and hides at the end. I2:
// scrollHeight and clientHeight are whole pixels rounded from fractional layout, so a range of up to 2 px counts as nothing to scroll.
test('the scroll cue shows while more of the panel body is below, hides at the end, and allows 2 px of rounding', () => {
  assert.equal(MORE_SLACK_PX, 2);
  const cases = [[0, 500, 500, false], [0, 501, 500, false], [0, 502, 500, false], [0, 503, 500, true], [100, 616, 500, true], [113, 616, 500, true], [114, 616, 500, false], [116, 616, 500, false]];
  assert.deepEqual(cases.map(([scrollTop, scrollHeight, clientHeight]) => hasMoreBelow({ scrollTop, scrollHeight, clientHeight })), cases.map((c) => c[3]));
  const { els, resizes } = panelRig();
  const body = els['species-body'];
  const cue = els['species-more'];
  assert.equal(cue.style.visibility, 'hidden', 'nothing to scroll');
  assert.ok(resizes.length === 1 && resizes[0].targets.includes(body), 'the body\'s size is observed');
  // R9-M1: the content is observed too. The datasets load after the panel is sized, so the body's box does not change and only an observer on
  // its children sees the content grow past it.
  assert.ok(resizes[0].targets.includes(els['species-datasets']), 'the Top datasets block, content inside the body, is observed');
  Object.assign(body, { scrollHeight: 616, clientHeight: 500 });
  resizes[0].onChange();
  assert.equal(cue.style.visibility, 'visible', 'content grew past the body');
  body.scrollTop = 116;
  body.listeners.scroll();
  assert.equal(cue.style.visibility, 'hidden', 'at the end');
  body.scrollTop = 40;
  body.listeners.scroll();
  assert.equal(cue.style.visibility, 'visible', 'scrolled back up');
  Object.assign(body, { scrollTop: 0, scrollHeight: 501, clientHeight: 500 });
  resizes[0].onChange();
  assert.equal(cue.style.visibility, 'hidden', 'I2: a 1 px range is rounding');
});

// I1 (final review): the status and error lines, Retry, the card foot and the close × used the shared --text-secondary (0.5 white), 2.96:1
// over a white basemap through the 0.72 glass. No text rule of the panel, the card or their dataset lists may use the shared 0.5 or 0.3
// white, and both surfaces have a background floor of 0.86, so text holds 4.5:1 over the lightest basemap (qa-species contrast measures it).
test('no SPECIES panel or card text uses the shared 0.5 or 0.3 white, and both surfaces have a background floor', () => {
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  // Comments are removed first, so a comment above a rule is not read as part of its selector.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const feature = rules.filter(({ selector }) => /\.species-|#species-|\.bio-card|\.dataset-/.test(selector));
  assert.ok(feature.length > 40, `positive control: the feature's rules are found (${feature.length})`);
  const dim = feature.filter(({ body }) => /(?:^|[;\s])color:\s*var\(--text-(?:secondary|dim)\)/.test(body)).map(({ selector }) => selector);
  assert.deepEqual(dim, [], 'rules still using the shared 0.5 or 0.3 white');
  for (const selector of ['.bio-card-close', '.bio-card-status', '.bio-card-retry', '.bio-card-foot', '.species-status']) {
    const rule = feature.find((r) => r.selector === selector);
    assert.ok(rule, `${selector} rule`);
    assert.match(rule.body, /(?:^|[;\s])color: rgba\(232, 234, 237, 0\.8\);/, `${selector} is 0.8 white`);
  }
  // R12-I1 (re-review): only the Top datasets rows scroll inside the card foot; the heading, the note and the gbif.org credit never shrink, so
  // the credit is visible at rest. The rows fade at the bottom while more of them is below, like the card body.
  // R13-M1: the species list and the rows share the card through .bio-card-main's grid (auto tracks: each item's min-height is its floor, and
  // the rest is shared in equal steps up to each track's content), with no window-height cap on the foot.
  const bodyOf = (selector) => feature.filter((r) => r.selector === selector).map((r) => r.body).join(' ');
  const main = bodyOf('.bio-card-main');
  for (const declaration of ['flex: 0 1 auto;', 'min-height: 0;', 'display: grid;', 'align-content: start;', 'grid-template-rows: [body] auto [foot-start datasets-start datasets-heading] auto [datasets-rows] auto [datasets-end foot-note] auto [foot-link] auto [foot-end];']) {
    assert.ok(main.includes(declaration), `.bio-card-main has ${declaration}`);
  }
  for (const declaration of ['grid-row: body;', 'overflow-y: auto;', 'min-height: 0;']) assert.ok(bodyOf('.bio-card-body').includes(declaration), `.bio-card-body has ${declaration}`);
  const foot = bodyOf('.bio-card-foot');
  for (const declaration of ['grid-row: foot-start / foot-end;', 'display: grid;', 'grid-template-rows: subgrid;']) assert.ok(foot.includes(declaration), `.bio-card-foot has ${declaration}`);
  assert.doesNotMatch(foot, /overflow-y: auto|max-height/, 'the foot itself neither scrolls nor has a cap');
  // Each @media block whose query names a height, cut out by counting braces: none may style the card.
  const heightQueries = [...css.matchAll(/@media [^{]*height[^{]*\{/g)].map((m) => {
    let depth = 1;
    let end = m.index + m[0].length;
    while (depth > 0 && end < css.length) { if (css[end] === '{') depth += 1; else if (css[end] === '}') depth -= 1; end += 1; }
    return css.slice(m.index, end);
  });
  assert.ok(heightQueries.length > 0, 'positive control: the stylesheet has height queries (for other surfaces)');
  assert.deepEqual(heightQueries.filter((block) => block.includes('.bio-card')), [], 'no window-height query sizes the card');
  for (const declaration of ['grid-row: datasets-start / datasets-end;', 'grid-template-rows: subgrid;']) assert.ok(bodyOf('.bio-card-foot .dataset-list').includes(declaration), `.bio-card-foot .dataset-list has ${declaration}`);
  // R13-M2: the rows are inset by the focus ring's reach (padding taken back by the margin), so a focused link's ring is not cut by their scroll clip.
  for (const declaration of ['grid-row: datasets-rows;', 'margin: 0 -3px;', 'padding: 3px;', 'scroll-padding: 3px;', 'min-height: calc(11px * 1.35 + 6px);', 'overflow-y: auto;']) assert.ok(bodyOf('.bio-card-foot .dataset-list-rows').includes(declaration), `the foot's dataset rows have ${declaration}`);
  for (const [selector, track] of [['.bio-card-foot-note', 'foot-note'], ['.bio-card-foot > a', 'foot-link'], ['.bio-card-foot .dataset-list-heading', 'datasets-heading']]) assert.ok(bodyOf(selector).includes(`grid-row: ${track};`), `${selector} sits on its own fixed track`);
  // Brief B S-1: the rows' "more below" cue is the panel's "more ↓" (same rule as .species-more), on the heading's line; the rows' fade is gone.
  assert.match(css, /\.species-more, \.dataset-list-more \{[^}]*visibility: hidden;[^}]*pointer-events: none;/);
  for (const declaration of ['grid-row: datasets-heading;', 'justify-self: end;']) assert.ok(bodyOf('.bio-card-foot .dataset-list-more').includes(declaration), `the rows' cue has ${declaration}`);
  assert.doesNotMatch(css, /--bio-card-datasets-fade|\.dataset-list-rows \{[^}]*mask-image/, 'no fade on the dataset rows');
  // Brief B: the shared host pill and header label text and its +/− button are 0.8 white (the shared 0.3 white measured 2.1:1 over the collapsed
  // glass on the light map and over ocean); one rule for every pill.
  const hostRule = (selector) => rules.find((r) => r.selector === selector)?.body ?? '';
  for (const selector of ['.panel-title', '.panel-collapse-btn']) assert.match(hostRule(selector), /(?:^|[;\s])color: rgba\(232, 234, 237, 0\.8\);/, `${selector} is 0.8 white`);
  // Critic 10 S1: the floor is for the open SPECIES panel and the card; the collapsed SPECIES pill keeps the shared glass of its sibling pills.
  assert.ok(bodyOf('.species-panel-inner').includes('background: var(--glass-bg);'), '.species-panel-inner keeps the shared glass');
  for (const selector of ['#species-panel:not(.collapsed) .species-panel-inner', '.bio-card']) {
    assert.match(bodyOf(selector), /(?:^|[;\s])background: rgba\(12, 12, 20, 0\.86\);/, `${selector} has the 0.86 background floor`);
  }
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
  // Brief B (fold): WHAT LIVES HERE is the body's first control, above the search box. The suggestions, the status line and the chosen
  // species' note all grow under the search box, so none of them can push the action out of the body's view (at 375x667 a two-line status
  // and the note put it 18 px below the view). B1/S1: the two chip rows follow the chosen-species block, each label beside its row in a group,
  // so the controls stay whole above the panel's cut on a 400x800 phone; the legend, the datasets and the credit line come after them.
  const panelHtml = stack.slice(stack.indexOf('id="species-panel"'));
  assert.match(panelHtml, /<div id="species-body" class="species-body">\s*(?:<!--[^>]*-->\s*)?<button [^>]*id="species-what-lives-here"[^>]*>WHAT LIVES HERE<\/button>\s*<label class="species-label" for="species-search">/);
  // The legend's content is rendered from SPECIES_MAP_LEGEND (speciesPanel.js), so the markup holds an empty container.
  assert.match(panelHtml, /<div id="species-chosen"[^>]*>\s*<span id="species-chosen-name"[^>]*><\/span>\s*<button [^>]*id="species-toggle"[^>]*>MAP OFF<\/button>\s*<span id="species-chosen-note" class="species-chosen-note" hidden><\/span>\s*<\/div>\s*<div class="species-chip-group">\s*<span id="species-years-label"/);
  assert.match(panelHtml, /<div class="species-chip-group">\s*<span id="species-radius-label"[^>]*>[^<]*<\/span>\s*<div id="species-radius"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<div id="species-legend" class="species-legend" hidden><\/div>/);
  // The map toggle is a switch with a fixed accessible name; aria-checked carries its state.
  const toggleTag = panelHtml.match(/<button [^>]*id="species-toggle"[^>]*>/)?.[0] ?? '';
  for (const attr of ['role="switch"', 'aria-checked="false"', 'aria-label="Species map"']) assert.ok(toggleTag.includes(attr), `${attr} in ${toggleTag}`);
  assert.equal(toggleTag.includes('aria-pressed'), false, `no aria-pressed on the switch: ${toggleTag}`);
  // R-7u: the top datasets sit directly under the legend, which they hide with.
  // I-2: the Top datasets block can take focus (Retry moves focus to it) and holds a polite live region from page load, then its content.
  // S5: its heading is markup, so a failed search keeps it above the message and Retry.
  assert.match(panelHtml, /<div id="species-legend" class="species-legend" hidden><\/div>\s*<div id="species-datasets" class="species-datasets" tabindex="-1" hidden>\s*<span id="species-datasets-heading" class="dataset-list-heading">Top datasets for this species<\/span>\s*<p id="species-datasets-status" class="species-datasets-status" role="status" aria-live="polite"><\/p>\s*<div id="species-datasets-content" class="species-datasets-content"><\/div>\s*<\/div>/);
  const order = ['id="species-what-lives-here"', 'id="species-search"', 'id="species-suggestions"', 'id="species-status"', 'id="species-chosen"', 'id="species-years-label"', 'id="species-years"', 'id="species-radius-label"', 'id="species-radius"', 'id="species-legend"', 'id="species-datasets"', 'class="species-credit"'];
  const positions = order.map((marker) => panelHtml.indexOf(marker));
  assert.ok(positions.every((at) => at >= 0), `every marker is present: ${JSON.stringify(Object.fromEntries(order.map((m, i) => [m, positions[i]])))}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'markup order');
  assert.doesNotMatch(panelHtml.slice(panelHtml.indexOf('class="species-credit"'), panelHtml.indexOf('id="species-more"')), /<button|<input|id="species-/, 'nothing after the credit line but the cue');
  // B1: the scroll cue is a row after the scrolling body, inside the panel, hidden from screen readers.
  assert.match(panelHtml, /<div id="species-body" class="species-body">/);
  assert.match(panelHtml, /<p class="species-credit">[\s\S]*?<\/p>\s*<\/div>\s*<div id="species-more" class="species-more" aria-hidden="true">more ↓<\/div>\s*<\/div>\s*<\/div>/);
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
  // B1/S1: the body scrolls under a fixed header, with the scroll cue in a row of its own below it; the legend has an opaque ground, so a
  // swatch cut by the panel's edge can never sit on the globe; on narrow screens the controls tighten so the action and both chip rows fit.
  assert.match(css, /#left-panel-stack > #species-panel:not\(\.collapsed\) \.species-panel-inner \{[^}]*overflow: hidden;/);
  assert.match(css, /#left-panel-stack > #species-panel:not\(\.collapsed\) \.species-body \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  // B1: no fade and no overlaying hint on the body. The cue is a row of its own with a reserved height, shown and hidden by visibility only,
  // never positioned over the body, and gone with the collapsed body. I1: the Top datasets heading scrolls with its links (sticky covered the
  // top link on a phone).
  assert.doesNotMatch(css, /--species-body-fade|--species-more|\.species-body::after|#species-panel \.species-body \{[^}]*mask-image/);
  assert.match(css, /\.species-more(?:, \.dataset-list-more)? \{[^}]*flex: 0 0 auto;[^}]*height: \d+px;[^}]*color: var\(--accent\);[^}]*visibility: hidden;/);
  assert.doesNotMatch(css, /\.species-more(?:, \.dataset-list-more)? \{[^}]*(?:position:|margin-top: -)/);
  assert.match(css, /#species-panel\.collapsed \.species-more \{ display: none !important; \}/);
  assert.doesNotMatch(css, /dataset-list-heading \{[^}]*sticky/);
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
  // M4 (final review): names come from iNaturalist and from GBIF (the suggest fallback, the match, and /v1/species/{key} common names), so both
  // credits name both; DATA_SOURCES.md lists every endpoint and states the name-search cap as what it is: one client-side limiter per page load.
  assert.match(credit.html, /Names: <a href="https:\/\/www\.inaturalist\.org"[^>]*>iNaturalist<\/a> and <a href="https:\/\/www\.gbif\.org"[^>]*>GBIF<\/a>\./);
  assert.doesNotMatch(credit.html, /suggested by/);
  assert.match(panelHtml, /<p class="species-credit"><span>Names: iNaturalist and GBIF<\/span>/);
  const sources = readFileSync(new URL('../../DATA_SOURCES.md', import.meta.url), 'utf8').split('\n');
  const speciesRow = sources.find((line) => line.startsWith('| Species map and "what lives here"')) ?? '';
  for (const endpoint of ['`/v1/taxa/autocomplete`', '`/v1/species/match`', '`/v1/species/{key}`', '`/v1/species/suggest`']) assert.ok(speciesRow.includes(endpoint), `DATA_SOURCES species row names ${endpoint}`);
  const inatRow = sources.find((line) => line.startsWith('| iNaturalist taxon autocomplete')) ?? '';
  assert.ok(inatRow.includes('≤ 60 name searches a minute per page load (client-side; resets on reload, not shared across tabs)'), 'the rate cell says what the limiter covers');
  assert.doesNotMatch(inatRow, /requests\/min per browser/);
  assert.ok(inatRow.includes('"Names: iNaturalist and GBIF" in the SPECIES panel'), 'the attribution cell quotes the panel credit');
});
