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

// S3: a species list longer than the card fades out at its bottom edge, the suggestion list's scroll cue: a scroll-driven mask that is 0 px
// when nothing scrolls.
test('the card body fades at the bottom while more of the list is below', () => {
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  // S4: the filter line under the heading is 0.8 white; the shared 0.5 white measured 4.09:1 over the card.
  assert.match(css, /\.bio-card-filter \{ color: rgba\(232, 234, 237, 0\.8\);/);
  assert.match(css, /@property --bio-card-body-fade \{[^}]*initial-value: 0px;/);
  assert.match(css, /@supports \(animation-timeline: scroll\(\)\) \{\s*\.bio-card-body \{[^}]*mask-image: linear-gradient\(to bottom, #000 calc\(100% - var\(--bio-card-body-fade\)\), transparent\);[^}]*animation-timeline: scroll\(self\);/);
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
      tag, hidden: false, id: '', className: '', textContent: '', innerHTML: '', attributes: {}, children: [], listeners: {}, style: {},
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

// R13-M1: the body and the foot are the two children of .bio-card-main, the grid that shares the card's height between them (style.css).
test('the card skeleton puts the body and the foot in the shared grid', () => {
  const card = createDetailsCard({ viewer: fakeViewer(), doc: cardDoc(), sanitize: (html) => html });
  assert.ok(card.element.innerHTML.includes('<div class="bio-card-filter"></div><div class="bio-card-main"><div class="bio-card-body"></div><div class="bio-card-foot"></div></div>'), card.element.innerHTML);
});

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

// M2 (final review): one Escape does one thing. The species search marks the Escape that hides its suggestion list as handled (preventDefault)
// before the document's listeners run, and the card then leaves it alone; an Escape nobody handled still dismisses the card.
test('an Escape another control handled leaves the card open; an unhandled Escape dismisses it', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const dismissed = [];
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => html, onDismiss: () => dismissed.push(true) });
  card.showStatus({ heading: 'What lives here', message: 'Click a spot on the globe. Esc cancels.' });
  const handled = { key: 'Escape', defaultPrevented: true };
  doc.listeners.keydown(handled);
  assert.equal(card.element.hidden, false, 'a handled Escape leaves the card open');
  assert.deepEqual(dismissed, [], 'and cancels nothing');
  doc.listeners.keydown({ key: 'Escape', defaultPrevented: false });
  assert.equal(card.element.hidden, true, 'positive control: an unhandled Escape dismisses the card');
  assert.deepEqual(dismissed, [true]);
});

// F9: where gbif.org cannot show the searched circle, the footer says so in plain text before its link.
test('a list footer can carry a plain-text note before its link; without one the footer is just the link', () => {
  const doc = cardDoc();
  const card = createDetailsCard({ viewer: fakeViewer(), doc, sanitize: (html) => html });
  const foot = card.element.querySelector('.bio-card-foot');
  const base = { heading: 'What lives here', filterLine: 'CC0 and CC BY records', entries: [], onRow: () => {} };
  card.showList({ ...base, footer: 'Occurrence data: GBIF.org, CC0 and CC BY records, all locations', footerHref: 'https://www.gbif.org/occurrence/search?license=CC0_1_0', footerNote: "gbif.org can't show this area as a circle" });
  assert.deepEqual(foot.children.map((c) => [c.tag, c.className, c.textContent]), [
    ['span', 'bio-card-foot-note', "gbif.org can't show this area as a circle"],
    ['a', '', 'Occurrence data: GBIF.org, CC0 and CC BY records, all locations'],
  ]);
  assert.equal(foot.children[1].href, 'https://www.gbif.org/occurrence/search?license=CC0_1_0');
  // M3: the gbif.org link opens in a new tab with no opener and no referrer, like the dataset links beside it.
  assert.deepEqual([foot.children[1].target, foot.children[1].rel], ['_blank', 'noopener noreferrer']);
  card.showList({ ...base, footer: 'Occurrence data: GBIF.org, CC0 and CC BY records only', footerHref: 'https://www.gbif.org/occurrence/search?geometry=x' });
  assert.deepEqual(foot.children.map((c) => c.tag), ['a'], 'no note, just the link');
});

const INAT_RG = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';
const OTHER_DATASET = '6ac3f774-d9fb-4796-b3e9-92bf6c81c084';

// R-7u: the what-lives-here list names its top datasets with DOI links above the gbif.org link (GBIF data user agreement: acknowledge the
// data publishers, with a DOI where appropriate). The note about the link stays next to the link.
test('a list foot names the top datasets above the gbif.org link; with none it is just the link', () => {
  const doc = cardDoc();
  const card = createDetailsCard({ viewer: fakeViewer(), doc, sanitize: (html) => html });
  const foot = card.element.querySelector('.bio-card-foot');
  const base = { heading: 'What lives here', filterLine: 'CC0 and CC BY records', entries: [], onRow: () => {}, footer: 'Occurrence data: GBIF.org, CC0 and CC BY records only', footerHref: 'https://www.gbif.org/occurrence/search?geometry=x' };
  card.showList({ ...base, datasets: [{ key: INAT_RG, count: 1179, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' }, { key: OTHER_DATASET, count: 3, error: 'HTTP 503' }] });
  assert.deepEqual(foot.children.map((c) => [c.tag, c.className]), [['div', 'dataset-list'], ['a', '']]);
  const [heading, list] = foot.children[0].children;
  assert.equal(heading.textContent, 'Top datasets in this area', 'S3: the card names whose datasets these are');
  assert.deepEqual(list.children.map((li) => li.children.map((c) => c.href || c.textContent)), [
    ['https://doi.org/10.15468/ab3s5x', '1,179'],
    [`https://www.gbif.org/dataset/${OTHER_DATASET}`, '3', 'dataset lookup failed: HTTP 503'],
  ]);
  assert.deepEqual(list.children.map((li) => [li.children[0].target, li.children[0].rel]), [['_blank', 'noopener noreferrer'], ['_blank', 'noopener noreferrer']]);
  card.showList({ ...base, footerNote: "gbif.org can't show this area as a circle", datasets: [{ key: INAT_RG, count: 1, title: 'iNaturalist Research-grade Observations', doi: null }] });
  assert.deepEqual(foot.children.map((c) => c.className), ['dataset-list', 'bio-card-foot-note', ''], 'the datasets, then the note about the link, then the link');
  card.showList(base);
  assert.deepEqual(foot.children.map((c) => c.tag), ['a'], 'no datasets: no block');
});

// Brief B S-1: the Top datasets rows carry the panel's "more ↓" cue (moreCue.js): shown while more rows are below their view, hidden at the
// end and when nothing is cut, on scroll and on a size change; a new list stops the old list's watcher. Positive control in the same test:
// the cue shows for a cut list before it is asserted hidden anywhere.
test('the Top datasets rows in the card show the SPECIES panel "more" cue while more rows are below', () => {
  const doc = cardDoc();
  const watched = [];
  const card = createDetailsCard({ viewer: fakeViewer(), doc, sanitize: (html) => html, observeSize: (targets, onChange) => { const entry = { targets, onChange, stopped: false }; watched.push(entry); return () => { entry.stopped = true; }; } });
  const foot = card.element.querySelector('.bio-card-foot');
  const base = { heading: 'What lives here', filterLine: 'CC0 and CC BY records', entries: [], onRow: () => {}, footer: 'Occurrence data: GBIF.org', footerHref: 'https://www.gbif.org/occurrence/search?geometry=x' };
  card.showList({ ...base, datasets: [{ key: INAT_RG, count: 1179, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' }] });
  const [, rows, cue] = foot.children[0].children;
  assert.deepEqual([cue.tag, cue.className, cue.textContent, cue.attributes['aria-hidden']], ['span', 'dataset-list-more', 'more ↓', 'true']);
  assert.equal(watched.length, 1);
  assert.deepEqual(watched[0].targets, [rows, ...rows.children], 'the rows and each row are watched for size changes');
  Object.assign(rows, { scrollTop: 0, scrollHeight: 185, clientHeight: 98 });
  watched[0].onChange();
  assert.equal(cue.style.visibility, 'visible', 'cut rows: the cue shows');
  rows.scrollTop = 87;
  rows.listeners.scroll();
  assert.equal(cue.style.visibility, 'hidden', 'scrolled to the end: the cue goes');
  Object.assign(rows, { scrollTop: 0, scrollHeight: 118, clientHeight: 118 });
  watched[0].onChange();
  assert.equal(cue.style.visibility, 'hidden', 'nothing cut: no cue');
  card.showList(base);
  assert.equal(watched[0].stopped, true, 'a new list stops the old watcher');
  assert.equal(rows.listeners.scroll, undefined, 'and removes its scroll listener');
  // Review M-4: closing the card stops the watcher too, not only the next render.
  card.showList({ ...base, datasets: [{ key: INAT_RG, count: 1, title: 'iNaturalist Research-grade Observations', doi: null }] });
  assert.equal(watched.length, 2);
  assert.equal(watched[1].stopped, false, 'positive control: a showing list is watched');
  card.close();
  assert.equal(watched[1].stopped, true, 'a closed card stops its watcher');
  assert.equal(foot.children[0].children[1].listeners.scroll, undefined, 'and removes its scroll listener');
});

// R-7e: the what-lives-here outline lives exactly as long as the card shows list or status content, so the card tells its
// owner (onListEnd) whenever that content stops showing: dismissed, closed, or replaced by a marker's details.
test('onListEnd fires once whenever list or status content stops showing, and never for other changes', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const ended = [];
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => html, onListEnd: () => ended.push(card.mode) });
  const whale = entityIn('occurrences', '<b>Blue whale</b>');
  const status = { heading: 'What lives here', message: 'Searching GBIF within 10 km…' };
  const list = { heading: 'What lives here', filterLine: 'CC0 and CC BY records', entries: [], footer: 'GBIF.org', footerHref: 'https://www.gbif.org/', onRow: () => {} };

  card.showStatus(status);
  card.showList(list);
  card.showStatus({ ...status, message: 'Click a spot on the globe. Esc cancels.' });
  assert.deepEqual(ended, [], 'status and list content replacing each other is not an end');

  viewer.selectedEntity = whale;
  assert.equal(card.mode, 'detail');
  assert.deepEqual(ended, ['detail'], "a marker's details replacing the list end it once, after the details show");
  viewer.selectedEntity = undefined;
  assert.equal(card.element.hidden, true, 'deselecting closes the details');
  assert.equal(ended.length, 1, 'closing details is not a list end');

  card.showStatus(status);
  doc.listeners.keydown({ key: 'Escape' });
  assert.deepEqual(ended.slice(1), [null], 'Escape on a status card ends it, after the card is closed');
  doc.listeners.keydown({ key: 'Escape' });
  assert.equal(ended.length, 2, 'a hidden card has nothing to end');

  card.showList(list);
  card.element.querySelector('.bio-card-close').listeners.click();
  assert.equal(ended.length, 3, 'the close button on a list ends it');

  card.showList(list);
  card.close();
  assert.equal(ended.length, 4, 'close() on a list ends it');
  card.close();
  assert.equal(ended.length, 4, 'close() on a hidden card ends nothing');

  viewer.selectedEntity = whale;
  card.showStatus(status);
  assert.equal(card.mode, 'list');
  assert.equal(ended.length, 4, 'status replacing details is not a list end');
});

// The owner's onListEnd runs inside the card's own state changes, so a throw there is logged under its own label: it cannot skip
// onDismiss (dismiss path) or be reported as a failure to render details (detail path).
test('a throwing onListEnd is logged under its own label, and dismiss still reaches onDismiss and details still show', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const dismissed = [];
  const card = createDetailsCard({ viewer, doc, sanitize: (html) => html, onDismiss: () => dismissed.push(card.element.hidden), onListEnd: () => { throw new Error('outline already removed'); } });
  const list = { heading: 'What lives here', filterLine: 'CC0 and CC BY records', entries: [], footer: 'GBIF.org', footerHref: 'https://www.gbif.org/', onRow: () => {} };
  const logged = [];
  const thrown = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    card.showStatus({ heading: 'What lives here', message: 'Searching GBIF within 10 km…' });
    try { doc.listeners.keydown({ key: 'Escape' }); } catch (error) { thrown.push(error.message); }
    card.showList(list);
    try { viewer.selectedEntity = entityIn('occurrences', '<b>Blue whale</b>'); } catch (error) { thrown.push(error.message); }
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(thrown, [], 'nothing escapes the card');
  assert.deepEqual(dismissed, [true], 'Escape still calls onDismiss once, after the card is hidden');
  assert.equal(card.mode, 'detail', "the marker's details replace the list");
  assert.equal(card.element.hidden, false, 'and show');
  assert.deepEqual(logged.map(([label]) => label), ['[bio-card] onListEnd failed', '[bio-card] onListEnd failed']);
  assert.deepEqual(logged.map(([, context]) => [context.from, context.to, context.error.message]), [['list', null, 'outline already removed'], ['list', 'detail', 'outline already removed']]);
});

// R13-M8: the card was an aria-live region, so a screen reader read the whole card each time it filled. The card is now a region labelled by its
// title and not live; a separate, visually hidden status line (outside the card, so it announces while the card is hidden) says in one short line
// what opened: "<layer> details opened", a status card's heading and message, or a list's heading and how many species it lists.
test('the card is not a live region; a short line in its own status region announces what opened', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const card = createDetailsCard({ viewer, doc, layerName: (id) => (id === 'occurrences' ? 'GBIF Occurrences' : id), sanitize: (html) => html });
  const root = card.element;
  const title = root.querySelector('.bio-card-title');
  assert.equal(Object.hasOwn(root.attributes, 'aria-live'), false, 'the card is not a live region');
  assert.equal(title.id, 'bio-card-title');
  assert.equal(root.attributes['aria-labelledby'], 'bio-card-title', 'the card is labelled by its title');
  // Fix round 1, I-1: a name needs a role that takes one. The card is an <aside> with no role override, so its role is complementary; a role-less
  // <div> would be generic and the browser would drop the name (qa card-a11y reads the resolved role and name from Chrome's accessibility tree).
  assert.equal(root.tag, 'aside', 'the card is an <aside> (role complementary, which can be named)');
  assert.equal(Object.hasOwn(root.attributes, 'role'), false, 'no role override');
  const announcer = card.announcer;
  assert.ok(announcer, 'the card has an announcer');
  assert.notEqual(announcer, root);
  assert.deepEqual([announcer.id, announcer.className, announcer.attributes.role, announcer.attributes['aria-live'], announcer.attributes['aria-atomic']], ['bio-card-announce', 'bio-card-announce', 'status', 'polite', 'true']);
  assert.equal(announcer.textContent, '', 'nothing is announced before the card opens');
  viewer.selectedEntity = entityIn('occurrences', '<b>Blue whale</b><p>a long description the card shows</p>');
  assert.equal(announcer.textContent, 'GBIF Occurrences details opened', 'a detail card announces one line, not its body');
  card.showStatus({ heading: 'What lives here', message: 'Searching GBIF within 10 km…' });
  assert.equal(announcer.textContent, 'What lives here: Searching GBIF within 10 km…');
  const entries = [{ key: 1, count: 3, scientificName: 'Branta canadensis', commonName: 'Canada Goose' }, { key: 2, count: 1, scientificName: 'Salix exigua', commonName: null }];
  card.showList({ heading: 'What lives here', filterLine: 'CC0 and CC BY records', entries, footer: 'GBIF.org', footerHref: 'https://www.gbif.org/', onRow: () => {} });
  assert.equal(announcer.textContent, 'What lives here: 2 species listed');
  card.close();
  assert.equal(announcer.textContent, '', 'closing clears the line');
});

test('startup puts the card announcer in the page, and it is visually hidden', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /document\.body\.appendChild\(bioCard\.element\);\s*document\.body\.appendChild\(bioCard\.announcer\);/);
  const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  const rule = css.match(/\.bio-card-announce \{([^}]*)\}/)?.[1] ?? '';
  for (const declaration of ['position: fixed;', 'width: 1px;', 'height: 1px;', 'overflow: hidden;', 'clip-path: inset(50%);', 'white-space: nowrap;']) assert.ok(rule.includes(declaration), `.bio-card-announce has ${declaration}`);
});

// Fix round 1, item 3: the line names the record that opened (the entity's name, else the first bold line of its details, else the layer), so
// opening another record in the same layer is new text. A line identical to the one showing (another record of the same name) is cleared and
// set again on the next frame, so a screen reader hears it again; a newer line or a close cancels that pending frame.
test('the details line names the record, and an identical line is cleared and set again on the next frame', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  const frames = [];
  const card = createDetailsCard({ viewer, doc, layerName: () => 'GBIF Occurrences', sanitize: (html) => html, nextFrame: (fn) => { frames.push(fn); return frames.length; }, cancelFrame: (id) => { frames[id - 1] = null; } });
  const announcer = card.announcer;
  const named = (id, name) => ({ ...entityIn('occurrences', '<b>x</b>'), id, name });
  viewer.selectedEntity = named('a', 'Blue whale');
  assert.equal(announcer.textContent, 'Blue whale details opened', 'the record is named');
  viewer.selectedEntity = named('b', 'Fin whale');
  assert.equal(announcer.textContent, 'Fin whale details opened', 'another record in the same layer is new text');
  assert.equal(frames.length, 0, 'different text is set at once');
  viewer.selectedEntity = named('c', 'Fin whale');
  assert.equal(announcer.textContent, '', 'the same text is cleared first');
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(announcer.textContent, 'Fin whale details opened', 'and set again on the next frame');
  viewer.selectedEntity = named('d', 'Fin whale');
  card.close();
  assert.equal(frames[1], null, 'a close cancels the pending line');
  assert.equal(announcer.textContent, '');
  // With no entity name, the first bold line of the details names the record; with neither, the layer does.
  const body = card.element.querySelector('.bio-card-body');
  body.querySelector('b').textContent = '  🐋 Blue whale ';
  viewer.selectedEntity = entityIn('occurrences', '<b>🐋 Blue whale</b> <i>Balaenoptera musculus</i>');
  // Brief B fix round 1, item 6: the layers lead a name with an icon ("🐋 Blue whale"), which a screen reader reads as "whale emoji"; the line
  // names the record without leading pictographs (emoji, their variation selectors, joiners, keycaps and flags). Digits and letters stay.
  // A name that is only an icon falls through to the details' bold line (here "Blue whale"), then to the layer.
  assert.equal(announcer.textContent, 'Blue whale details opened');
  for (const [name, heard] of [['🦋 Monarch', 'Monarch'], ['🏳️\u200d🌈  Pride', 'Pride'], ['🇺🇸 US bird', 'US bird'], ['7 spot ladybird', '7 spot ladybird'], ['Grey seal 🦭', 'Grey seal 🦭'], ['🦭', 'Blue whale']]) {
    viewer.selectedEntity = { ...entityIn('occurrences', '<b>x</b>'), id: `emoji-${name}`, name };
    assert.equal(announcer.textContent, `${heard} details opened`, name);
  }
  body.querySelector('b').textContent = '';
  viewer.selectedEntity = { ...entityIn('occurrences', 'plain text'), id: 'e2' };
  assert.equal(announcer.textContent, 'GBIF Occurrences details opened');
});

// Final review m-3: in clean view and recording mode the card is display: none (style.css), so its status line stays silent: no "details
// opened" for a card nobody can see. Positive control in the same test: the same selection announces once the card renders again.
test('the status line says nothing while the card is not rendered (clean view, recording mode)', () => {
  const doc = cardDoc();
  const viewer = fakeViewer();
  let rendered = false;
  const frames = [];
  const card = createDetailsCard({ viewer, doc, layerName: () => 'GBIF Occurrences', sanitize: (html) => html, isRendered: () => rendered, nextFrame: (fn) => { frames.push(fn); return frames.length; }, cancelFrame: () => {} });
  viewer.selectedEntity = { ...entityIn('occurrences', '<b>x</b>'), id: 'a', name: 'Blue whale' };
  assert.equal(card.announcer.textContent, '', 'hidden card: nothing announced');
  card.showStatus({ heading: 'What lives here', message: 'GBIF search failed (HTTP\u00a0503)' });
  assert.equal(card.announcer.textContent, '', 'hidden card: a status is not announced either');
  rendered = true;
  viewer.selectedEntity = { ...entityIn('occurrences', '<b>x</b>'), id: 'b', name: 'Fin whale' };
  assert.equal(card.announcer.textContent, 'Fin whale details opened', 'positive control: a rendered card announces');
  viewer.selectedEntity = { ...entityIn('occurrences', '<b>x</b>'), id: 'c', name: 'Fin whale' };
  rendered = false;
  frames.at(-1)();
  assert.equal(card.announcer.textContent, '', 'a repeat set after the card stopped rendering stays silent');
});

// Fix round 1, item 4: the card was a live region, so failed name and dataset lookups in a list were read out with it. The status line now says
// them: how many of each failed and why, after the species count. Positive control in the same test: a list with no failures says only the count.
test('a list line names its failed name and dataset lookups', () => {
  const doc = cardDoc();
  const card = createDetailsCard({ viewer: fakeViewer(), doc, sanitize: (html) => html });
  const base = { heading: 'What lives here', filterLine: 'CC0 and CC BY records', footer: 'GBIF.org', footerHref: 'https://www.gbif.org/', onRow: () => {} };
  const ok = { key: 1, count: 3, scientificName: 'Branta canadensis', commonName: 'Canada Goose' };
  card.showList({ ...base, entries: [ok], datasets: [{ key: INAT_RG, count: 3, title: 'iNaturalist', doi: null }] });
  assert.equal(card.announcer.textContent, 'What lives here: 1 species listed', 'no failures: the count only');
  const failedName = (key, error) => ({ key, count: 1, scientificName: `GBIF taxon ${key}`, commonName: null, error });
  card.showList({
    ...base,
    entries: [ok, failedName(2, 'HTTP\u00a0503'), failedName(3, 'HTTP\u00a0503'), failedName(4, 'timeout')],
    datasets: [{ key: INAT_RG, count: 3, title: null, doi: null, error: 'HTTP\u00a0503' }, { key: '6ac3f774-d9fb-4796-b3e9-92bf6c81c084', count: 1, title: 'Other', doi: null }],
  });
  assert.equal(card.announcer.textContent, 'What lives here: 4 species listed; 3 name lookups failed (HTTP\u00a0503, timeout); 1 dataset lookup failed (HTTP\u00a0503)');
});
