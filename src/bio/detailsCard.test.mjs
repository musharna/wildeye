// src/bio/detailsCard.test.mjs — which clicks open the card, that every listed layer id is a real data source,
// and that GBIF strings render as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { BIO_CARD_LAYER_IDS, cardDecision, createDetailsCard, listRows, renderListInto } from './detailsCard.js';

const entityIn = (layerId, description) => ({
  id: 'e1',
  entityCollection: { owner: { name: layerId } },
  description: description === undefined ? undefined : { getValue: () => description },
});

test('the card opens for a biology marker with details and stays shut for anything else', () => {
  assert.deepEqual(cardDecision(entityIn('occurrences', '<b>Blue whale</b>')), { open: true, layerId: 'occurrences', html: '<b>Blue whale</b>' });
  assert.equal(cardDecision(entityIn('flights', '<b>UAL1</b>')).open, false, 'flights keep their own readout');
  assert.equal(cardDecision(entityIn('occurrences')).open, false, 'no description');
  assert.equal(cardDecision(entityIn('occurrences', '   ')).open, false, 'blank description');
  assert.equal(cardDecision({ id: 'loose', description: { getValue: () => 'x' } }).open, false, 'not in a data source');
  assert.equal(cardDecision(undefined).open, false, 'selection cleared');
});

test('every card layer id is the name of a real data source', () => {
  const dir = new URL('../data/', import.meta.url);
  const names = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    for (const match of readFileSync(new URL(file, dir), 'utf8').matchAll(/new Cesium\.CustomDataSource\(["']([a-z0-9-]+)["']\)/g)) names.add(match[1]);
  }
  for (const id of BIO_CARD_LAYER_IDS) assert.ok(names.has(id), `${id} has no CustomDataSource("${id}") in src/data`);
  assert.equal(BIO_CARD_LAYER_IDS.has('flights'), false);
  assert.equal(BIO_CARD_LAYER_IDS.size, 19);
});

test('list rows put the common name first and format counts', () => {
  assert.deepEqual(listRows([
    { key: 1, count: 3524, scientificName: 'Branta canadensis', commonName: 'Canada Goose' },
    { key: 2, count: 3, scientificName: 'Salix exigua', commonName: null, error: 'HTTP 503' },
  ]), [
    { key: 1, primary: 'Canada Goose', secondary: 'Branta canadensis', count: '3,524', note: '' },
    { key: 2, primary: 'Salix exigua', secondary: '', count: '3', note: 'name lookup failed: HTTP 503' },
  ]);
});

function fakeDoc() {
  const make = (tag) => {
    const el = {
      tag, children: [], listeners: {}, textContent: '', className: '', type: '',
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...kids) { this.children = kids; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
    };
    Object.defineProperty(el, 'innerHTML', { set() { throw new Error('innerHTML used for external strings'); } });
    return el;
  };
  return { createElement: make };
}

test('rows from GBIF render as text, never markup, and a click hands back the row', () => {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  const clicked = [];
  const rows = listRows([{ key: 9, count: 1, scientificName: '<img src=x onerror=alert(1)>', commonName: null }]);
  renderListInto(container, rows, doc, (row) => clicked.push(row.key));
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].className, 'bio-card-row');
  assert.equal(container.children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  container.children[0].listeners.click();
  assert.deepEqual(clicked, [9]);
});

// A stand-in for the browser pieces createDetailsCard touches: querySelector hands back one fake per selector.
function cardDoc() {
  const listeners = {};
  const make = (tag) => {
    const parts = {};
    return {
      tag, hidden: false, id: '', className: '', textContent: '', innerHTML: '', attributes: {}, children: [], listeners: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...kids) { this.children = kids; this.innerHTML = ''; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector(selector) { return (parts[selector] ||= make(selector)); },
    };
  };
  return { listeners, createElement: make, addEventListener(type, fn) { listeners[type] = fn; } };
}

// Like Cesium's Viewer: selectedEntityChanged fires only when the selected value actually changes.
function fakeViewer() {
  const handlers = [];
  let selected;
  return {
    clock: { currentTime: 'now' },
    selectedEntityChanged: { addEventListener: (fn) => handlers.push(fn) },
    get selectedEntity() { return selected; },
    set selectedEntity(value) {
      if (value === selected) return;
      selected = value;
      for (const fn of handlers) fn(value);
    },
  };
}

test('detail mode renders only what the sanitizer returns', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const seen = [];
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => { seen.push(html); return '<b>clean</b>'; } });
  const raw = '<b>Blue whale</b><img src=x onerror="alert(1)">';
  viewer.selectedEntity = entityIn('occurrences', raw);
  assert.equal(card.element.hidden, false);
  assert.deepEqual(seen, [raw], 'the layer description goes through the sanitizer');
  assert.equal(card.element.querySelector('.bio-card-body').innerHTML, '<b>clean</b>', 'the body holds the sanitizer output, not the raw description');
});

test('Escape and the close button both deselect, so the same marker opens the card again', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => html });
  const whale = entityIn('occurrences', '<b>Blue whale</b>');
  viewer.selectedEntity = whale;
  assert.equal(card.element.hidden, false, 'first click opens the card');
  doc.listeners.keydown({ key: 'Escape' });
  assert.equal(card.element.hidden, true, 'Escape hides the card');
  assert.equal(viewer.selectedEntity, undefined, 'Escape clears the selection');
  viewer.selectedEntity = whale;
  assert.equal(card.element.hidden, false, 'the same marker opens the card again after Escape');
  card.element.querySelector('.bio-card-close').listeners.click();
  assert.equal(card.element.hidden, true, 'close button hides the card');
  assert.equal(viewer.selectedEntity, undefined, 'close button clears the selection');
  viewer.selectedEntity = whale;
  assert.equal(card.element.hidden, false, 'the same marker opens the card again after the close button');
});

// R-4d: the "what lives here" controller calls showStatus while a detail card may be open. Replacing the detail
// must clear the selection too, or Escape hides the card with the marker still selected and it cannot reopen.
test('status content replacing a detail card clears the selection, so the same marker opens the card again', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => html });
  const whale = entityIn('occurrences', '<b>Blue whale</b>');
  viewer.selectedEntity = whale;
  assert.equal(card.mode, 'detail', 'the marker opens a detail card');
  card.showStatus({ heading: 'What lives here', message: 'Click a spot on the globe. Esc cancels.' });
  assert.equal(viewer.selectedEntity, undefined, 'replacing the detail clears the selection');
  assert.equal(card.element.hidden, false, 'the status card is visible');
  assert.equal(card.mode, 'list', 'the card is in list mode');
  doc.listeners.keydown({ key: 'Escape' });
  assert.equal(card.element.hidden, true, 'Escape hides the status card');
  viewer.selectedEntity = whale;
  assert.equal(card.element.hidden, false, 'the same marker opens the card again');
  assert.equal(card.mode, 'detail', 'and it is a detail card');
});

// R-6b: dismissing the card tells its owner, so a "what lives here" search the card was waiting for is cancelled
// and cannot reopen the card when it settles.
test('Escape and the close button each call onDismiss once; a card that is already hidden calls nothing', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const dismissed = [];
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => html, onDismiss: () => dismissed.push(card.element.hidden) });
  doc.listeners.keydown({ key: 'Escape' });
  card.element.querySelector('.bio-card-close').listeners.click();
  assert.deepEqual(dismissed, [], 'nothing to dismiss while the card is hidden');
  card.showStatus({ heading: 'What lives here', message: 'Searching GBIF within 10 km…' });
  doc.listeners.keydown({ key: 'Escape' });
  assert.deepEqual(dismissed, [true], 'Escape calls onDismiss once, after the card is hidden');
  doc.listeners.keydown({ key: 'Escape' });
  assert.equal(dismissed.length, 1, 'a second Escape on the hidden card calls nothing');
  viewer.selectedEntity = entityIn('occurrences', '<b>Blue whale</b>');
  assert.equal(card.element.hidden, false, 'a marker opens the card');
  card.element.querySelector('.bio-card-close').listeners.click();
  assert.deepEqual(dismissed, [true, true], 'the close button calls onDismiss once, after the card is hidden');
  assert.equal(viewer.selectedEntity, undefined, 'the close button still deselects');
  card.element.querySelector('.bio-card-close').listeners.click();
  assert.equal(dismissed.length, 2, 'the close button on the hidden card calls nothing');
});
