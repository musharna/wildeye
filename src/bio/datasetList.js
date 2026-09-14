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

/** The block: a heading, then one row per dataset (its link, its count, and a note for a failed lookup). Links open in a new tab with no opener or referrer. */
export function createDatasetList(doc, datasets, { heading = DATASETS_HEADING } = {}) {
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const block = make('div', 'dataset-list');
  const list = make('ol', 'dataset-list-rows');
  list.setAttribute('aria-label', heading);
  for (const row of datasetRows(datasets)) {
    const item = make('li', 'dataset-row');
    const link = make('a', 'dataset-row-link', row.text);
    link.href = row.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.appendChild(link);
    item.appendChild(make('span', 'dataset-row-count', row.count));
    if (row.note) item.appendChild(make('span', 'dataset-row-note', row.note));
    list.appendChild(item);
  }
  block.appendChild(make('span', 'dataset-list-heading', heading));
  block.appendChild(list);
  return block;
}
