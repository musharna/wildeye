import { effortNote } from '../data/effort.js';
import { DEFAULT_SPECIES_PARAMS } from '../data/species.js';

/**
 * The RECORDING EFFORT row of the species card (spec: docs/superpowers/specs/2026-09-30-effort-layer-design.md). For each chosen species:
 * look up its GBIF record (shared with the modeled-range row, one request) and offer the switch (off) for its class, or say why not.
 * The map follows the species map's years. A newer pick supersedes a lookup in flight.
 */
export function createEffortControl({ doc = document, dataManager, client, layer, now = () => new Date() }) {
  const el = (id) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`SPECIES panel: #${id} is missing from index.html`);
    return node;
  };
  const box = el('species-effort');
  const toggle = el('species-effort-toggle');
  const note = el('species-effort-note');
  let key = null;
  let place = null;

  const params = () => dataManager.getLayerParams('species') ?? DEFAULT_SPECIES_PARAMS;

  function render() {
    box.hidden = key === null;
    const shown = place?.state === 'shown';
    const on = shown && layer.isEnabled();
    toggle.hidden = !shown;
    toggle.textContent = on ? 'RECORDING EFFORT ON' : 'RECORDING EFFORT OFF';
    toggle.setAttribute('aria-checked', String(on));
    const error = shown ? layer.getStatus().error : null;
    note.textContent = place ? error ?? effortNote({ ...place, years: layer.getStatus().years, now: now() }) : '';
  }

  async function lookUp(taxonKey) {
    let record;
    try {
      record = await client.speciesName(taxonKey);
    } catch (error) {
      if (taxonKey !== key) return;
      console.error('[effort] GBIF lookup failed', { taxonKey, error });
      place = { state: 'lookup-failed', error: error.message };
      render();
      return;
    }
    if (taxonKey !== key) return; // a newer pick owns the row
    if (record.classKey === null || !record.className) {
      place = { state: 'no-class' };
    } else {
      place = { state: 'shown', className: record.className };
      layer.setTaxon({ classKey: record.classKey, className: record.className });
    }
    render();
  }

  function onSpecies() {
    layer.setYears(params().years);
    const next = params().taxonKey ?? null;
    if (next === key) { render(); return; }
    key = next;
    layer.setTaxon(null);
    place = key === null ? null : { state: 'loading' };
    render();
    if (key !== null) void lookUp(key);
  }

  toggle.addEventListener('click', () => {
    if (place?.state !== 'shown') return;
    layer.setEnabled(!layer.isEnabled());
    render();
  });
  dataManager.subscribe((change) => { if (change?.layerId === 'species') onSpecies(); });
  layer.onStatus(render);
  render(); // the row starts hidden, whatever the markup says
  onSpecies();
  return { render };
}
