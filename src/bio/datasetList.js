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

/** The block: a heading, then its rows (createDatasetRows). */
export function createDatasetList(doc, datasets, { heading = DATASETS_HEADING } = {}) {
  const block = make(doc, 'div', 'dataset-list');
  block.appendChild(make(doc, 'span', 'dataset-list-heading', heading));
  block.appendChild(createDatasetRows(doc, datasets, { label: heading }));
  return block;
}
