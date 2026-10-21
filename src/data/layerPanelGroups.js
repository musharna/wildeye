/**
 * The Layers panel's grouped list, "On now" strip, search box and header count (grill_wildeye_layers_ux_2026-10-20).
 * The data manager still builds and refreshes each layer row; this module owns where a row sits (its group body) and the
 * chrome around the rows. Grouping and matching are pure helpers in layerGroups.js; this file is the DOM half, checked in a
 * real browser by scripts/qa-layers-ux.mjs.
 */
import { LAYER_GROUPS, layerMatchesQuery, orderLayersForPanel } from './layerGroups.js';

// The strip lists this many layers before the rest fold behind "+k more". A count, not a measured line limit: the names
// are long (up to ~290 px at 12 px against a ~240 px panel), so each layer takes its own line and may wrap.
const STRIP_MAX = 4;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container The scrolling list (`#data-toggles`); group sections are rendered into it.
 * @param {ReadonlyArray<object>} [options.groups] Authored groups (default LAYER_GROUPS).
 * @param {(layerId: string) => void} options.onTurnOff Turns a layer off, as the row's own button would.
 * @param {Document} [options.doc]
 */
export function createGroupedLayersPanel({ container, groups = LAYER_GROUPS, onTurnOff, doc = document }) {
  const expanded = new Set();
  let layersById = new Map();
  let query = '';
  let stripKey = null;
  let stripExpanded = false;
  let sections = new Map();

  // Header count: "3 on" beside the panel title, so the collapsed pill says it too.
  const header = container.parentElement?.querySelector('.panel-header');
  const headerCount = el(doc, 'span', 'panel-count');
  headerCount.hidden = true;
  header?.querySelector('.panel-title')?.after(headerCount);

  // Above the scrolling list, the layers that are on, one per line; they never scroll away. The header's "3 on" names
  // the strip, so it carries no label of its own (a phone gives the whole panel 322 px: style.css, the 50vh line).
  const tools = el(doc, 'div', 'layers-tools');
  const strip = el(doc, 'div', 'layers-on');
  strip.hidden = true;
  tools.hidden = true;
  const chips = el(doc, 'ul', 'layers-on-chips');
  chips.setAttribute('aria-label', 'Layers that are on');
  const more = el(doc, 'button', 'layers-on-more');
  more.type = 'button';
  more.hidden = true;
  strip.append(chips, more);

  const search = el(doc, 'input', 'layers-search');
  search.type = 'search';
  search.placeholder = 'Search';
  search.setAttribute('aria-label', 'Search layers by name or source');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const empty = el(doc, 'p', 'layers-search-empty', 'No layer matches.');
  empty.hidden = true;
  tools.append(strip);
  container.before(tools);
  // Search sits in the header row, in the divider's place, so it costs the list no height.
  (header?.querySelector('.panel-divider') || headerCount).before(search);

  search.addEventListener('input', () => {
    query = search.value;
    applyFilter();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return;
    event.preventDefault();
    event.stopPropagation();
    search.value = '';
    query = '';
    applyFilter();
  });

  more.addEventListener('click', () => {
    stripExpanded = !stripExpanded;
    fitStrip();
  });

  chips.addEventListener('click', (event) => {
    const button = event.target?.closest?.('button');
    const id = button?.closest('.layers-on-chip')?.dataset.chipLayer;
    if (!id) return;
    if (button.classList.contains('layers-on-off')) onTurnOff(id);
    else reveal(id);
  });

  function setExpanded(groupId, open) {
    const section = sections.get(groupId);
    if (!section) return;
    if (open) expanded.add(groupId);
    else expanded.delete(groupId);
    section.head.setAttribute('aria-expanded', open ? 'true' : 'false');
    section.body.hidden = !open;
    section.root.classList.toggle('open', open);
  }

  // Bring a layer's row into view: clear any search, open its group, scroll to it and focus its switch.
  function reveal(layerId) {
    const groupId = [...sections.values()].find((s) => s.ids.includes(layerId))?.id;
    if (!groupId) return;
    if (query) {
      search.value = '';
      query = '';
      applyFilter();
    }
    setExpanded(groupId, true);
    const row = container.querySelector(`[data-layer-id="${layerId}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.querySelector('.data-toggle-btn')?.focus({ preventScroll: true });
  }

  function applyFilter() {
    const active = query.trim() !== '';
    let shown = 0;
    for (const section of sections.values()) {
      let matches = 0;
      for (const row of section.body.querySelectorAll('.data-toggle-row')) {
        const layer = layersById.get(row.dataset.layerId);
        const match = !active || (layer && layerMatchesQuery(layer, query));
        row.hidden = !match;
        if (match) matches += 1;
      }
      section.root.hidden = active && matches === 0;
      section.body.hidden = active ? matches === 0 : !expanded.has(section.id);
      section.head.setAttribute('aria-expanded', section.body.hidden ? 'false' : 'true');
      shown += matches;
    }
    empty.hidden = !active || shown > 0;
  }

  // Fold layers past STRIP_MAX behind "+k more"; pressed, it lists them all and reads "Show fewer".
  function fitStrip() {
    const items = [...chips.children];
    const overflow = items.length - STRIP_MAX;
    items.forEach((item, i) => { item.hidden = !stripExpanded && i >= STRIP_MAX; });
    more.hidden = overflow <= 0;
    more.textContent = stripExpanded ? 'Show fewer' : `+${overflow} more`;
    more.setAttribute('aria-expanded', stripExpanded ? 'true' : 'false');
  }

  return {
    /**
     * Rebuild the group sections and say where each row goes, in order.
     * @param {Array<object>} layers `getAll()` projection.
     * @returns {Array<{layer: object, parent: HTMLElement}>}
     */
    layout(layers) {
      const ordered = orderLayersForPanel(layers, groups);
      sections = new Map();
      const placement = [];
      for (const { group, layers: members } of ordered) {
        const root = el(doc, 'section', 'layer-group');
        root.dataset.groupId = group.id;
        const head = el(doc, 'button', 'layer-group-head');
        head.type = 'button';
        const bodyId = `layer-group-${group.id}`;
        head.setAttribute('aria-controls', bodyId);
        const caret = el(doc, 'span', 'layer-group-caret');
        caret.setAttribute('aria-hidden', 'true');
        const label = el(doc, 'span', 'layer-group-label', group.label);
        const onCount = el(doc, 'span', 'layer-group-on');
        onCount.hidden = true;
        const total = el(doc, 'span', 'layer-group-count', String(members.length));
        total.setAttribute('aria-label', `${members.length} layers`);
        head.append(caret, label, onCount, total);
        const body = el(doc, 'div', 'layer-group-body');
        body.id = bodyId;
        root.append(head, body);
        container.appendChild(root);
        const section = { id: group.id, root, head, body, onCount, ids: members.map((layer) => layer.id) };
        sections.set(group.id, section);
        head.addEventListener('click', () => setExpanded(group.id, body.hidden));
        setExpanded(group.id, expanded.has(group.id));
        for (const layer of members) placement.push({ layer, parent: body });
      }
      container.appendChild(empty);
      stripKey = null;
      return placement;
    },

    /**
     * Follow layer state: strip chips, per-group and header counts, and the current search.
     * @param {Array<object>} layers `getAll()` projection.
     */
    sync(layers) {
      layersById = new Map(layers.map((layer) => [layer.id, layer]));
      const on = [];
      for (const section of sections.values()) {
        const groupOn = section.ids.filter((id) => layersById.get(id)?.enabled);
        section.onCount.hidden = groupOn.length === 0;
        section.onCount.textContent = `${groupOn.length} on`;
        section.root.classList.toggle('has-on', groupOn.length > 0);
        on.push(...groupOn);
      }
      headerCount.hidden = on.length === 0;
      headerCount.textContent = `${on.length} on`;
      strip.hidden = on.length === 0;
      tools.hidden = strip.hidden;

      const key = on.join('\n');
      if (key !== stripKey) {
        stripKey = key;
        if (on.length === 0) stripExpanded = false;
        const existing = new Map([...chips.children].map((item) => [item.dataset.chipLayer, item]));
        chips.replaceChildren(...on.map((id) => {
          const name = layersById.get(id)?.name || id;
          const item = existing.get(id) || el(doc, 'li', 'layers-on-chip');
          if (!existing.has(id)) {
            item.dataset.chipLayer = id;
            item.dataset.groupId = [...sections.values()].find((section) => section.ids.includes(id))?.id || '';
            const nameButton = el(doc, 'button', 'layers-on-name', name);
            nameButton.type = 'button';
            nameButton.title = `Show ${name} in the list`;
            const off = el(doc, 'button', 'layers-on-off');
            off.type = 'button';
            off.setAttribute('aria-label', `Turn off ${name}`);
            off.title = `Turn off ${name}`;
            item.append(nameButton, off);
          }
          return item;
        }));
        fitStrip();
      }
      if (query) applyFilter();
    },
  };
}
