// MAP STACK source chips — the always-visible replacement for the `<select>`
// that used to sit in the Map Stack panel. One button per stack, rendered from
// `MapStackController.getStacks()`. The sources below are the whole shipped
// set; keeping the allowlist explicit means a stack added to
// `MAP_STACKS` for internal use cannot reach the tray until someone names it
// here.
//
// The chips are a control SURFACE only: selecting one calls back into the same
// `_setMapStack()` path the dropdown's `change` handler used, and the active
// state is re-synced from controller state (never optimistically), so a failed
// or superseded switch still leaves the truly-active stack lit.

export const MAP_STACK_CHIP_CLASS = 'map-stack-chip';
export const PRESENTED_MAP_STACK_IDS = Object.freeze([
  'esri-imagery',
  'osm',
]);

/**
 * Presentation model for one map-stack chip.
 * @param {{id: string, label: string}} stack - Stack descriptor from `getStacks()`.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {{id: string, label: string, active: boolean}}
 */
export function mapStackChipModel(stack, activeId) {
  return {
    id: String(stack?.id ?? ''),
    label: String(stack?.label ?? stack?.id ?? ''),
    active: !!stack?.id && stack.id === activeId,
  };
}

/**
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {Array<object>} One chip model per approved presentation id, in
 *   `PRESENTED_MAP_STACK_IDS` order; internal and future stacks stay hidden.
 */
export function mapStackChipModels(stacks, activeId) {
  const stacksById = new Map((Array.isArray(stacks) ? stacks : [])
    .map((stack) => [stack?.id, stack]));
  return PRESENTED_MAP_STACK_IDS
    .map((id) => stacksById.get(id))
    .filter(Boolean)
    .map((stack) => mapStackChipModel(stack, activeId));
}

/**
 * Renders the chip row into `container`, replacing any previous chips.
 * @param {HTMLElement} container - Row element.
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {object} [options]
 * @param {string|null} [options.activeId] - Currently active stack id.
 * @param {(stackId: string) => void} [options.onSelect] - Selection callback.
 * @param {Document} [options.doc] - Document override (tests).
 * @returns {Array<object>} The rendered chip models.
 */
export function renderMapStackChips(container, stacks, { activeId = null, onSelect = null, doc } = {}) {
  if (!container) return [];
  const ownerDoc = doc || container.ownerDocument || globalThis.document;
  if (!ownerDoc?.createElement) return [];

  container.innerHTML = '';
  const models = mapStackChipModels(stacks, activeId);

  for (const model of models) {
    const chip = ownerDoc.createElement('button');
    chip.type = 'button';
    chip.className = [MAP_STACK_CHIP_CLASS, model.active ? 'active' : ''].filter(Boolean).join(' ');
    chip.dataset.stackId = model.id;
    chip.title = model.label;
    chip.setAttribute('aria-pressed', String(model.active));

    const label = ownerDoc.createElement('span');
    label.className = 'map-stack-chip-label';
    label.textContent = model.label;
    chip.appendChild(label);

    chip.addEventListener('click', () => { onSelect?.(model.id); });
    container.appendChild(chip);
  }

  return models;
}

/**
 * Re-points the active chip at controller state: only the active/pressed pair changes.
 * @param {HTMLElement} container - Row element.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {void}
 */
export function syncMapStackChips(container, activeId) {
  const chips = container?.children;
  if (!chips) return;
  for (const chip of Array.from(chips)) {
    const stackId = chip?.dataset?.stackId;
    if (!stackId) continue;
    const active = stackId === activeId;
    chip.classList?.toggle('active', active);
    chip.setAttribute?.('aria-pressed', String(active));
  }
}
