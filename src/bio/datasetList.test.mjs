// src/bio/datasetList.test.mjs — 'Top datasets' rows (R-7u): facet order, DOI or gbif.org links, counts, failed lookups, text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatasetList, createDatasetRows, datasetRows, DATASETS_HEADING, showTallLinkStart, tallLinkScroll } from './datasetList.js';

const INAT_RG = '50c9509d-22c7-4a22-a47d-8c48425ef4a7'; // DOI 10.15468/ab3s5x (live 2026-09-14)
const OTHER = '6ac3f774-d9fb-4796-b3e9-92bf6c81c084';
const THIRD = 'cca13f2c-0d2c-4c2f-93b9-4446c0cc1629';

// Elements as the renderer touches them; innerHTML throws, so any markup path fails the test.
function fakeDoc() {
  const make = (tag) => {
    const el = {
      tag, children: [], attributes: {}, textContent: '', className: '', href: '', target: '', rel: '',
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
    };
    Object.defineProperty(el, 'innerHTML', { set() { throw new Error('innerHTML used for GBIF strings'); } });
    return el;
  };
  return { createElement: make };
}

test('dataset rows keep facet order, link a DOI on doi.org or else the gbif.org dataset page, format counts, and name a failed lookup', () => {
  // titles and DOIs other than the iNaturalist one are fixtures
  assert.deepEqual(datasetRows([
    { key: INAT_RG, count: 41111, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' },
    { key: OTHER, count: 306, title: 'Dataset without a DOI', doi: null },
    { key: THIRD, count: 3, title: 'Dataset with an odd DOI', doi: 'javascript:alert(1)' },
    { key: OTHER, count: 2, error: 'HTTP 503' },
  ]), [
    { key: INAT_RG, text: 'iNaturalist Research-grade Observations', href: 'https://doi.org/10.15468/ab3s5x', count: '41,111', note: '' },
    { key: OTHER, text: 'Dataset without a DOI', href: 'https://www.gbif.org/dataset/' + OTHER, count: '306', note: '' },
    { key: THIRD, text: 'Dataset with an odd DOI', href: 'https://www.gbif.org/dataset/' + THIRD, count: '3', note: '' },
    { key: OTHER, text: 'GBIF dataset ' + OTHER, href: 'https://www.gbif.org/dataset/' + OTHER, count: '2', note: 'dataset lookup failed: HTTP 503' },
  ]);
  assert.throws(() => datasetRows([{ key: '../occurrence/1', count: 1, title: 'x', doi: null }]), /dataset key/, 'a key that is not a dataset UUID is refused, not linked');
});

test('the Top datasets block is built with text only, and every link is https in a new tab with no opener or referrer', () => {
  const doc = fakeDoc();
  const block = createDatasetList(doc, [
    { key: INAT_RG, count: 27513, title: '<img src=x onerror=alert(1)>', doi: '10.15468/ab3s5x' },
    { key: OTHER, count: 5, error: 'timeout' },
  ]);
  assert.equal(DATASETS_HEADING, 'Top datasets');
  assert.deepEqual([block.tag, block.className], ['div', 'dataset-list']);
  const [heading, list, cue] = block.children;
  // Brief B S-1: the rows' "more ↓" cue follows them, hidden from screen readers (its visibility is set by moreCue.watchMoreBelow).
  assert.deepEqual([block.children.length, cue.tag, cue.className, cue.textContent, cue.attributes['aria-hidden']], [3, 'span', 'dataset-list-more', 'more ↓', 'true']);
  assert.deepEqual([heading.tag, heading.className, heading.textContent], ['span', 'dataset-list-heading', 'Top datasets']);
  assert.deepEqual([list.tag, list.className, list.attributes['aria-label']], ['ol', 'dataset-list-rows', 'Top datasets']);
  assert.deepEqual(list.children.map((li) => [li.tag, li.className, li.children.map((c) => [c.tag, c.className, c.textContent])]), [
    ['li', 'dataset-row', [['a', 'dataset-row-link', '<img src=x onerror=alert(1)>'], ['span', 'dataset-row-count', '27,513']]],
    ['li', 'dataset-row', [['a', 'dataset-row-link', 'GBIF dataset ' + OTHER], ['span', 'dataset-row-count', '5'], ['span', 'dataset-row-note', 'dataset lookup failed: timeout']]],
  ]);
  assert.deepEqual(list.children.map((li) => { const a = li.children[0]; return [a.href, a.target, a.rel]; }), [
    ['https://doi.org/10.15468/ab3s5x', '_blank', 'noopener noreferrer'],
    ['https://www.gbif.org/dataset/' + OTHER, '_blank', 'noopener noreferrer'],
  ]);
  assert.equal(createDatasetList(doc, [], { heading: 'Top datasets' }).children[1].children.length, 0, 'no datasets: an empty list under the heading');
});

// S5: the SPECIES panel keeps its heading in the page through every state, so it takes the rows alone, labelled by that heading's id.
test('the rows can be built on their own, labelled by a heading elsewhere in the page', () => {
  const list = createDatasetRows(fakeDoc(), [{ key: INAT_RG, count: 3, title: 'iNaturalist Research-grade Observations', doi: '10.15468/ab3s5x' }], { labelledBy: 'species-datasets-heading' });
  assert.deepEqual([list.tag, list.className, list.attributes['aria-labelledby'], list.attributes['aria-label']], ['ol', 'dataset-list-rows', 'species-datasets-heading', undefined]);
  assert.deepEqual(list.children.map((li) => [li.children[0].href, li.children[0].rel, li.children[1].textContent]), [['https://doi.org/10.15468/ab3s5x', 'noopener noreferrer', '3']]);
});

// #174. Geometry as measured on the live card at 667x375 on 2026-11-21: the rows' view 25 px from 223.7, 3 px of scroll padding, link lines of
// 16.2 px. The real layout is checked by scripts/qa-species.mjs (card-foot-rest); these pin the rule.
test('a focused link taller than the rows\' view is scrolled to its start, and one that fits is left to the browser', () => {
  const view = { viewTop: 223.7, viewHeight: 25, inset: 3 };
  assert.equal(tallLinkScroll({ ...view, linkTop: 212.5, linkHeight: 48.6 }), 212.5 - 226.7, 'three lines in a one-line view, top above it: scrolled up by 14.2 px to the padding');
  assert.equal(tallLinkScroll({ ...view, linkTop: 260, linkHeight: 48.6 }), 260 - 226.7, 'below the view: scrolled down to the same place');
  assert.equal(tallLinkScroll({ ...view, linkTop: 212.5, linkHeight: 16.2 }), 0, 'one line fits 25 - 2 x 3 px: not moved, wherever it is');
  assert.equal(tallLinkScroll({ ...view, linkTop: 212.5, linkHeight: 19 }), 0, 'exactly the view inside its padding still fits');
  assert.notEqual(tallLinkScroll({ ...view, linkTop: 212.5, linkHeight: 19.5 }), 0, 'half a pixel more does not');
  assert.equal(tallLinkScroll({ viewTop: 223.7, viewHeight: 25, inset: 0, linkTop: 212.5, linkHeight: 19.5 }), 0, 'the padding is part of the rule: with none, 19.5 px fits 25');
});

test('focus on a dataset link scrolls its rows by the rule, from the rows\' own measurements; focus elsewhere in the rows moves nothing', () => {
  const listeners = {};
  const rows = {
    scrollTop: 40, clientTop: 1, clientHeight: 25,
    addEventListener(type, fn) { listeners[type] = fn; },
    getBoundingClientRect: () => ({ top: 222.7 }),
  };
  const link = (top, height) => ({ getBoundingClientRect: () => ({ top, height }) });
  const target = (found) => ({ closest: (selector) => (selector === '.dataset-row-link' ? found : null) });
  showTallLinkStart(rows, { computedStyle: (element) => (element === rows ? { scrollPaddingTop: '3px' } : {}) });
  assert.deepEqual(Object.keys(listeners), ['focusin']);
  listeners.focusin({ target: target(null) });
  assert.equal(rows.scrollTop, 40, 'not a dataset link: nothing moves');
  listeners.focusin({ target: target(link(212.5, 16.2)) });
  assert.equal(rows.scrollTop, 40, 'a link that fits: nothing moves');
  listeners.focusin({ target: target(link(212.5, 48.6)) });
  assert.ok(Math.abs(rows.scrollTop - (40 + 212.5 - (222.7 + 1 + 3))) < 1e-9, `a tall link: its top goes to the view's top (box top + border) plus the padding, got ${rows.scrollTop}`);
});
