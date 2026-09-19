// src/bio/datasetList.test.mjs — 'Top datasets' rows (R-7u): facet order, DOI or gbif.org links, counts, failed lookups, text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatasetList, createDatasetRows, datasetRows, DATASETS_HEADING } from './datasetList.js';

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
