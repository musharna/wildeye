/**
 * 'Top datasets' (R-7u): the GBIF datasets behind a what-lives-here list or a species map, each named by its title linked to its DOI on
 * doi.org (or to its gbif.org page), with its record count. The GBIF data user agreement asks users to acknowledge the data publishers,
 * with a DOI where appropriate (spec: Implementation notes). GBIF strings go through textContent only.
 */
import { datasetHref } from './gbif.js';

export const DATASETS_HEADING = 'Top datasets';

/** Display rows in facet order. A failed lookup ({ key, count, error }) names the key and links the dataset page on gbif.org. */
export function datasetRows(datasets) {
  return datasets.map((dataset) => {
    const failed = Boolean(dataset.error);
    return {
      key: dataset.key,
      text: failed ? 'GBIF dataset ' + dataset.key : dataset.title,
      href: datasetHref({ key: dataset.key, doi: failed ? null : dataset.doi }),
      count: Number(dataset.count).toLocaleString('en-US'),
      note: failed ? 'dataset lookup failed: ' + dataset.error : '',
    };
  });
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The rows alone: one list item per dataset (its link, its count, and a note for a failed lookup), named by `label`, or by the element whose
 * id is `labelledBy` (the SPECIES panel's heading is in its markup). Links open in a new tab with no opener or referrer.
 */
export function createDatasetRows(doc, datasets, { label = DATASETS_HEADING, labelledBy = null } = {}) {
  const list = make(doc, 'ol', 'dataset-list-rows');
  if (labelledBy) list.setAttribute('aria-labelledby', labelledBy);
  else list.setAttribute('aria-label', label);
  for (const row of datasetRows(datasets)) {
    const item = make(doc, 'li', 'dataset-row');
    const link = make(doc, 'a', 'dataset-row-link', row.text);
    link.href = row.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.appendChild(link);
    item.appendChild(make(doc, 'span', 'dataset-row-count', row.count));
    if (row.note) item.appendChild(make(doc, 'span', 'dataset-row-note', row.note));
    list.appendChild(item);
  }
  return list;
}

/**
 * How far a rows' view must scroll for a focused link too tall for it to show its start (#174): 0 when the link fits the view inside its
 * scroll padding (`inset`), where the browser's own focus scroll shows it whole; otherwise the distance that puts the link's top at the
 * view's top, inside the padding. Left alone, the browser does not move a link that already covers the view, so a four-line name in a
 * one-line view (667x375) showed a middle line with its focus ring cut at both edges. Tops and heights in px, tops in one coordinate space.
 */
export function tallLinkScroll({ viewTop, viewHeight, linkTop, linkHeight, inset }) {
  if (linkHeight <= viewHeight - 2 * inset) return 0;
  return linkTop - (viewTop + inset);
}

/** Keep the start of a focused link in view where `rows` scrolls and the link is taller than its view (tallLinkScroll). */
export function showTallLinkStart(rows, { computedStyle = (element) => globalThis.getComputedStyle(element) } = {}) {
  rows.addEventListener('focusin', (event) => {
    const link = event.target?.closest?.('.dataset-row-link');
    if (!link) return;
    const view = rows.getBoundingClientRect();
    const box = link.getBoundingClientRect();
    const inset = Number.parseFloat(computedStyle(rows).scrollPaddingTop) || 0;
    rows.scrollTop += tallLinkScroll({ viewTop: view.top + rows.clientTop, viewHeight: rows.clientHeight, linkTop: box.top, linkHeight: box.height, inset });
  });
}

/**
 * The block: a heading, then its rows (createDatasetRows), then the "more ↓" cue for the rows (brief B S-1), hidden from screen readers.
 * Children in that order: [heading, rows, cue]. The cue starts hidden; watchMoreBelow (moreCue.js) shows it while more rows are below.
 */
export function createDatasetList(doc, datasets, { heading = DATASETS_HEADING } = {}) {
  const block = make(doc, 'div', 'dataset-list');
  block.appendChild(make(doc, 'span', 'dataset-list-heading', heading));
  block.appendChild(createDatasetRows(doc, datasets, { label: heading }));
  const cue = make(doc, 'span', 'dataset-list-more', 'more ↓');
  cue.setAttribute('aria-hidden', 'true');
  block.appendChild(cue);
  return block;
}
