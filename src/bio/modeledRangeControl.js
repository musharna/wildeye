import { modeledNote, placeTaxon } from '../data/modeledRange.js';

/**
 * The MODELED RANGE row of the species card (spec: docs/superpowers/specs/2026-09-30-modeled-range-design.md). For each chosen species:
 * look up its GBIF record and the geomodel species list, then offer the switch (off) when the range may be shown, or say why not.
 * A newer pick supersedes a lookup in flight; the previous species' range goes the moment the pick changes.
 */
export function createModeledRangeControl({ doc = document, dataManager, client, layer, loadList }) {
  const el = (id) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`SPECIES panel: #${id} is missing from index.html`);
    return node;
  };
  const box = el('species-modeled');
  const toggle = el('species-modeled-toggle');
  const note = el('species-modeled-note');
  let key = null;
  let place = null;

  function render() {
    box.hidden = key === null;
    const shown = place?.state === 'shown';
    const on = shown && layer.isEnabled();
    toggle.hidden = !shown;
    toggle.textContent = on ? 'MODELED RANGE ON' : 'MODELED RANGE OFF';
    toggle.setAttribute('aria-checked', String(on));
    const error = shown ? layer.getStatus().error : null;
    note.textContent = place ? error ?? modeledNote(place) : '';
  }

  async function lookUp(taxonKey) {
    let list = null;
    let listError = null;
    try {
      list = await loadList();
    } catch (error) {
      console.error('[modeled-range] species list failed to load', { error });
      listError = error;
    }
    let record;
    try {
      record = await client.speciesName(taxonKey);
    } catch (error) {
      if (taxonKey !== key) return;
      console.error('[modeled-range] GBIF lookup failed', { taxonKey, error });
      place = { state: 'lookup-failed', error: error.message };
      render();
      return;
    }
    if (taxonKey !== key) return; // a newer pick owns the row
    place = listError ? { state: 'no-list', error: listError.message } : placeTaxon(record, list);
    if (place.state === 'shown') layer.setTaxon({ id: place.id, name: record.scientificName, group: place.group, month: place.month });
    render();
  }

  function onSpecies() {
    const next = dataManager.getLayerParams('species')?.taxonKey ?? null;
    if (next === key) return;
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
