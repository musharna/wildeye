// Stage 3 "What's here" (grill A14): the WHAT LIVES HERE card also lists what each enabled GIBS layer holds at
// the clicked spot. The rows belong to one status/list render: reset() clears them, so a marker's details or
// any other use of the card never shows another search's values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailsCard } from './detailsCard.js';

function cardDoc() {
  const listeners = {};
  const make = (tag) => {
    const parts = {};
    return {
      tag, hidden: false, id: '', className: '', textContent: '', innerHTML: '', href: '', target: '', rel: '', title: '', attributes: {}, children: [], listeners: {}, style: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...kids) { this.children = kids; this.innerHTML = ''; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
      querySelector(selector) { return (parts[selector] ||= make(selector)); },
      getClientRects() { return this.hidden ? [] : [{}]; },
    };
  };
  return { listeners, createElement: make, addEventListener(type, fn) { listeners[type] = fn; } };
}
const fakeViewer = () => ({ clock: { currentTime: 'now' }, selectedEntityChanged: { addEventListener() {} }, selectedEntity: undefined });
const texts = (card) => card.element.querySelector('.bio-card-layers').children.map((c) => c.textContent);
const LIST = { heading: 'What lives here', filterLine: 'x', entries: [{ key: 1, count: 1, scientificName: 'A b', commonName: null }], onRow() {}, footer: 'f', footerHref: 'https://www.gbif.org/' };

test('layer rows render with a status, stay through setLayers updates, and show again with the list', () => {
  const card = createDetailsCard({ viewer: fakeViewer(), doc: cardDoc(), sanitize: (h) => h });
  const ul = card.element.querySelector('.bio-card-layers');
  card.showStatus({ heading: 'What lives here', message: 'Searching…', layers: ['🗺️ Land cover: reading…'] });
  assert.deepEqual(texts(card), ['🗺️ Land cover: reading…']);
  assert.equal(ul.hidden, false);
  card.setLayers(['🗺️ Land cover: Evergreen Broadleaf Forests · 2024-01-01']);
  assert.deepEqual(texts(card), ['🗺️ Land cover: Evergreen Broadleaf Forests · 2024-01-01']);
  assert.equal(card.element.querySelector('.bio-card-body').children.length, 1); // the status line survived: setLayers does not reset
  card.showList({ ...LIST, layers: ['🗺️ Land cover: Evergreen Broadleaf Forests · 2024-01-01'] });
  assert.deepEqual(texts(card), ['🗺️ Land cover: Evergreen Broadleaf Forests · 2024-01-01']);
});

test('a render without layers clears the previous rows and hides the block', () => {
  const card = createDetailsCard({ viewer: fakeViewer(), doc: cardDoc(), sanitize: (h) => h });
  card.showStatus({ heading: 'What lives here', message: 'm', layers: ['a'] });
  card.showList(LIST);
  assert.deepEqual(texts(card), []);
  assert.equal(card.element.querySelector('.bio-card-layers').hidden, true);
});

test('rows are text, never markup', () => {
  const card = createDetailsCard({ viewer: fakeViewer(), doc: cardDoc(), sanitize: (h) => h });
  card.showStatus({ heading: 'h', message: 'm', layers: ['<img src=x onerror=alert(1)>'] });
  const li = card.element.querySelector('.bio-card-layers').children[0];
  assert.equal(li.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(li.innerHTML, '');
});
