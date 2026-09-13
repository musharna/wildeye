// src/bio/detailsCard.test.mjs — which clicks open the card, that every listed layer id is a real data source,
// and that GBIF strings render as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { BIO_CARD_LAYER_IDS, cardDecision, listRows, renderListInto } from './detailsCard.js';

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
