/**
 * SPECIES panel (spec: docs/superpowers/specs/2026-09-13-species-search-design.md): name search with
 * suggestions, the chosen species with a map switch and a record-count legend, the "What lives here" button, and year and radius chips.
 */
import { SPECIES_MAP_LEGEND } from './gbif.js';

export const MIN_QUERY_LENGTH = 3;
export const SUGGEST_DEBOUNCE_MS = 300;

/**
 * "Common · Scientific (rank)", plus the term iNaturalist matched, which can be another common name ("Hump-back Cicada" for Swamp
 * Cicada). The term shows only when neither shown name contains the typed query and the term is not itself a shown name, so a row
 * whose name already explains the match ("Humpback Whale" for "hump") carries no note.
 */
export function suggestionText(item, query) {
  if (typeof query !== 'string') throw new TypeError(`suggestionText: the typed query is required (got ${typeof query})`);
  const text = `${item.commonName ? `${item.commonName} · ` : ''}${item.scientificName} (${item.rank})`;
  const term = item.matchedTerm;
  if (!term) return text;
  const typed = query.trim().toLowerCase();
  const names = [item.commonName, item.scientificName].filter((name) => typeof name === 'string').map((name) => name.toLowerCase());
  const explained = names.some((name) => name === term.toLowerCase() || (typed !== '' && name.includes(typed)));
  return explained ? text : `${text} — matched "${term}"`;
}

const compactCount = (count) => (count >= 1000 ? `${count / 1000}k` : String(count));

/** A class's label: its upper bound ("≤1k"), or "more than" the previous bound for the open top class (">100k"). */
export function legendLabel(classes, index) {
  const { upTo } = classes[index];
  if (upTo !== null) return `≤${compactCount(upTo)}`;
  if (index === 0) throw new Error('legendLabel: an open class needs a bounded class before it');
  return `>${compactCount(classes[index - 1].upTo)}`;
}

/**
 * The record-count legend from SPECIES_MAP_LEGEND: a caption, then one swatch per class in the colour the globe draws it (aria-hidden)
 * with its bound as text, so the classes read out as a list labelled by the caption.
 */
export function renderLegendInto(container, doc, legend = SPECIES_MAP_LEGEND) {
  const caption = doc.createElement('span');
  caption.id = 'species-legend-caption';
  caption.className = 'species-legend-caption';
  caption.textContent = legend.caption;
  const list = doc.createElement('ol');
  list.className = 'species-legend-classes';
  list.setAttribute('aria-labelledby', caption.id);
  legend.classes.forEach((cls, index) => {
    const item = doc.createElement('li');
    item.className = 'species-legend-class';
    const swatch = doc.createElement('span');
    swatch.className = 'species-legend-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.backgroundColor = cls.color;
    const label = doc.createElement('span');
    label.className = 'species-legend-label';
    label.textContent = legendLabel(legend.classes, index);
    item.appendChild(swatch);
    item.appendChild(label);
    list.appendChild(item);
  });
  container.replaceChildren(caption, list);
}

export function createSpeciesPanel({ doc = document, dataManager, speciesLayer, client, whatLivesHere, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const el = (id) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`SPECIES panel: #${id} is missing from index.html`);
    return node;
  };
  const input = el('species-search');
  const list = el('species-suggestions');
  const status = el('species-status');
  const chosen = el('species-chosen');
  const chosenName = el('species-chosen-name');
  const toggle = el('species-toggle');
  const legend = el('species-legend');
  const yearChips = el('species-years');
  const radiusChips = el('species-radius');
  const armButton = el('species-what-lives-here');
  let timer = null;
  let suggestAbort = null;
  let chooseAbort = null;
  let lookingUpKey = null;
  renderLegendInto(legend, doc);

  const params = () => dataManager.getLayerParams('species') || { taxonKey: null, name: null, years: 'recent', radiusKm: 10 };

  function render() {
    const p = params();
    const on = dataManager.isEnabled('species');
    chosen.hidden = !p.taxonKey;
    chosenName.textContent = p.name || (p.taxonKey ? `GBIF taxon ${p.taxonKey}` : '');
    if (p.taxonKey && !p.name && lookingUpKey !== p.taxonKey) {
      // A share link carries only the key; look the name up once.
      lookingUpKey = p.taxonKey;
      client.speciesName(p.taxonKey).then((found) => {
        const current = params();
        if (current.taxonKey === found.key && !current.name) {
          dataManager.setLayerParams('species', { name: found.commonName || found.scientificName }, { origin: 'programmatic' });
        }
      }, (error) => {
        console.error('[species] name lookup failed', { taxonKey: p.taxonKey, error });
        status.textContent = `GBIF name lookup failed (${error.message})`;
      });
    }
    toggle.textContent = on ? 'MAP ON' : 'MAP OFF';
    toggle.setAttribute('aria-pressed', String(on));
    legend.hidden = !on;
    for (const chip of yearChips.querySelectorAll('[data-years]')) chip.setAttribute('aria-pressed', String(chip.dataset.years === p.years));
    for (const chip of radiusChips.querySelectorAll('[data-radius]')) chip.setAttribute('aria-pressed', String(Number(chip.dataset.radius) === p.radiusKm));
    const stats = speciesLayer.getStats();
    if (stats.error) status.textContent = `GBIF ${stats.error} (${stats.tileFailures} tile errors)`;
    armButton.setAttribute('aria-pressed', String(whatLivesHere.armed));
    armButton.textContent = whatLivesHere.armed ? 'CLICK THE GLOBE · ESC CANCELS' : 'WHAT LIVES HERE';
  }

  function clearSuggestions() {
    list.replaceChildren();
    list.hidden = true;
  }

  function showSuggestions(result, query) {
    list.replaceChildren();
    status.textContent = result.notice || '';
    for (const item of result.items) {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'species-suggestion';
      button.textContent = suggestionText(item, query);
      button.addEventListener('click', () => { void choose(item); });
      li.appendChild(button);
      list.appendChild(li);
    }
    list.hidden = result.items.length === 0;
    if (result.items.length === 0 && result.source !== 'none') status.textContent = `No names match "${query}".`;
  }

  async function requestSuggestions() {
    const query = input.value.trim();
    suggestAbort?.abort();
    if (query.length < MIN_QUERY_LENGTH) {
      clearSuggestions();
      return;
    }
    suggestAbort = new AbortController();
    try {
      // Worded for the query that was sent: the box may have changed while it was out.
      showSuggestions(await client.suggest(query, { signal: suggestAbort.signal }), query);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('[species] name search failed', { query, error });
      clearSuggestions();
      status.textContent = `Name search failed (${error.message})`;
    }
  }

  /** Put a GBIF taxon on the map. Used by suggestions and by "what lives here" rows. */
  async function chooseTaxon({ taxonKey, name }) {
    if (!dataManager.setLayerParams('species', { taxonKey, name }, { origin: 'user' })) {
      throw new Error(`species layer rejected taxon ${taxonKey}`);
    }
    if (!dataManager.isEnabled('species')) await dataManager.setEnabled('species', true, { origin: 'user' });
    render();
    return true;
  }

  async function choose(item) {
    chooseAbort?.abort();
    chooseAbort = new AbortController();
    clearSuggestions();
    status.textContent = `Looking up ${item.scientificName} in GBIF…`;
    try {
      const taxonKey = item.gbifKey ?? await client.match(item.scientificName, { signal: chooseAbort.signal });
      if (!taxonKey) {
        status.textContent = `${item.scientificName} is not in GBIF.`;
        return false;
      }
      await chooseTaxon({ taxonKey, name: item.commonName || item.scientificName });
      input.value = '';
      status.textContent = '';
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      console.error('[species] could not choose species', { item, error });
      status.textContent = `GBIF lookup failed (${error.message})`;
      return false;
    }
  }

  input.addEventListener('input', () => {
    clearTimer(timer);
    timer = setTimer(() => { void requestSuggestions(); }, SUGGEST_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') list.querySelector('button')?.click();
    if (event.key === 'Escape') clearSuggestions();
  });
  toggle.addEventListener('click', () => {
    void dataManager.setEnabled('species', !dataManager.isEnabled('species'), { origin: 'user' }).then(render);
  });
  yearChips.addEventListener('click', (event) => {
    const chip = event.target?.closest?.('[data-years]');
    if (!chip) return;
    dataManager.setLayerParams('species', { years: chip.dataset.years }, { origin: 'user' });
    render();
  });
  radiusChips.addEventListener('click', (event) => {
    const chip = event.target?.closest?.('[data-radius]');
    if (!chip) return;
    dataManager.setLayerParams('species', { radiusKm: Number(chip.dataset.radius) }, { origin: 'user' });
    render();
  });
  armButton.addEventListener('click', () => {
    if (whatLivesHere.armed) whatLivesHere.disarm();
    else whatLivesHere.arm();
    render();
  });
  dataManager.subscribe((change) => { if (change?.layerId === 'species') render(); });
  speciesLayer.onStatus(render);
  render();

  return { choose, chooseTaxon, render };
}
