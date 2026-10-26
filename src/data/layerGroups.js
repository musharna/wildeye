/**
 * The Layers panel's groups (grill_wildeye_layers_ux_2026-10-20). Authored per layer, never guessed from a name: a layer
 * shown in the panel without a group here makes `orderLayersForPanel` throw, the way an unregistered share disposition
 * makes `finalizeRegistrations` throw, and layerGroups.test.mjs holds this map to REGISTERED_LAYER_IDS.
 * Groups render in this order; layers inside a group render alphabetically by their display name.
 */
export const LAYER_GROUPS = Object.freeze([
  { id: 'movement', label: 'Animal movement', layers: ['birds', 'aloft', 'tracks', 'otn', 'cetaceans'] },
  {
    id: 'records',
    label: 'Species records',
    layers: ['occurrences', 'obis-grid', 'camera-traps', 'edna', 'neon', 'biotime', 'phenology', 'penguins'],
  },
  {
    id: 'patterns',
    label: 'Biodiversity patterns',
    layers: ['bii', 'reptiles', 'mammals', 'gibs-mammals', 'gibs-amphibians', 'soil-bacteria', 'freshwater-fish',
      'plants-wcvp', 'hotspots', 'griis'],
  },
  {
    id: 'habitats',
    label: 'Habitats',
    layers: ['ifl', 'forty', 'natural-lands', 'wetlands', 'tidal-marsh', 'seagrass', 'kelp', 'gmw', 'surface-water',
      'gibs-landcover', 'gibs-biomass', 'gibs-canopy', 'ecoregions', 'marine-realms'],
  },
  { id: 'land', label: 'Land conditions', layers: ['ndvi', 'soil-moisture', 'gibs-evi', 'gibs-gpp', 'gibs-lst', 'drought', 'fires', 'gibs-disturbance', 'aef-change', 'rivers'] },
  {
    id: 'ocean',
    label: 'Ocean conditions',
    layers: ['oisst', 'chlor-a', 'cmems-pft', 'cmems-o2', 'cmems-ph', 'cmems-zooc', 'crw-seaice', 'mhw', 'haedat'],
  },
  { id: 'coral', label: 'Coral heat stress', layers: ['crw-bleaching', 'crw-outlook', 'crw-dhw', 'crw-hotspot'] },
  {
    id: 'disease',
    label: 'Disease and vectors',
    layers: ['malaria', 'neon-vectors', 'arbonet', 'hpai', 'h5n1', 'whispers', 'wastewater'],
  },
  {
    id: 'human',
    label: 'Human impact',
    layers: ['human-footprint', 'hansen-loss', 'loss-drivers', 'gfw', 'gibs-nightlights', 'gibs-anthromes', 'protected-areas'],
  },
].map((group) => Object.freeze({ ...group, layers: Object.freeze(group.layers) })));

/**
 * Index layer id → group id, refusing a layer filed twice.
 * @param {ReadonlyArray<{id: string, layers: ReadonlyArray<string>}>} groups
 * @returns {Map<string, string>}
 */
export function groupIndex(groups) {
  const index = new Map();
  for (const group of groups) {
    for (const id of group.layers) {
      if (index.has(id)) throw new Error(`Layer ${id} is in two Layers-panel groups (${index.get(id)}, ${group.id})`);
      index.set(id, group.id);
    }
  }
  return index;
}

/**
 * Arrange the panel's layers into their groups: groups in authored order, layers by display name. A panel layer with no
 * group throws (no catch-all bucket); a grouped id with no registered layer is skipped, so a test manager holding a few
 * layers still renders.
 * @param {ReadonlyArray<{id: string, name: string, showInTogglePanel?: boolean}>} layers Registered layers (`getAll()`).
 * @param {ReadonlyArray<{id: string, label: string, layers: ReadonlyArray<string>}>} groups
 * @returns {Array<{group: object, layers: Array<object>}>}
 */
export function orderLayersForPanel(layers, groups) {
  const index = groupIndex(groups);
  const byGroup = new Map(groups.map((group) => [group.id, []]));
  for (const layer of layers) {
    if (layer.showInTogglePanel === false) continue;
    const groupId = index.get(layer.id);
    if (!groupId) throw new Error(`Layer ${layer.id} has no Layers-panel group (src/data/layerGroups.js)`);
    byGroup.get(groupId).push(layer);
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  return groups
    .map((group) => ({ group, layers: byGroup.get(group.id).sort((a, b) => collator.compare(a.name, b.name)) }))
    .filter((entry) => entry.layers.length > 0);
}

/**
 * Does a layer match a search query? Every whitespace-separated term must appear in its name or source, ignoring case.
 * An empty query matches everything.
 * @param {{name: string, source?: string}} layer
 * @param {string} query
 * @returns {boolean}
 */
export function layerMatchesQuery(layer, query) {
  const terms = String(query || '').toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${layer.name || ''} ${layer.source || ''}`.toLocaleLowerCase('en');
  return terms.every((term) => haystack.includes(term));
}
