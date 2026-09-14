/**
 * Fits expanded panels into a shared vertical corridor. Natural heights are
 * retained when they fit; constrained panels keep a usable floor and share
 * the remaining room in proportion to their unmet height.
 *
 * @param {object} input Layout measurements.
 * @param {number[]} input.naturalHeights Expanded-panel natural heights.
 * @param {number} input.availableHeight Height available to expanded panels.
 * @param {number} [input.minimumHeight=96] Preferred usable floor per panel.
 * @returns {number[]} One allocated height per expanded panel.
 */
export function allocatePanelStackHeights({
  naturalHeights,
  availableHeight,
  minimumHeight = 96,
}) {
  const natural = naturalHeights.map((height) => Math.max(0, Number(height) || 0));
  if (!natural.length) return [];

  const available = Math.max(0, Number(availableHeight) || 0);
  const naturalTotal = natural.reduce((sum, height) => sum + height, 0);
  if (naturalTotal <= available) return natural;
  if (available === 0) return natural.map(() => 0);

  const preferredFloor = Math.max(0, Number(minimumHeight) || 0);
  const base = natural.map((height) => Math.min(height, preferredFloor));
  const baseTotal = base.reduce((sum, height) => sum + height, 0);
  if (baseTotal >= available) {
    const scale = baseTotal > 0 ? available / baseTotal : 0;
    return base.map((height) => height * scale);
  }

  const remaining = available - baseTotal;
  const unmet = natural.map((height, index) => Math.max(0, height - base[index]));
  const unmetTotal = unmet.reduce((sum, height) => sum + height, 0);
  if (unmetTotal <= 0) return base;
  return base.map((height, index) => height + remaining * (unmet[index] / unmetTotal));
}

/**
 * Solves the accordion corridor's bottom boundary against the obstacles that
 * still limit it.
 *
 * Every painted obstacle limits the corridor. This includes Cockpit CONTACT
 * and peripheral HUD surfaces, so reopening a map panel cannot cover them.
 *
 * @param {object} input Corridor measurements.
 * @param {number} input.baseBottom Viewport-inset bottom boundary, in px.
 * @param {Array<{top: number}>} [input.obstacles] Live obstacle tops.
 * @param {number} [input.safeGap=0] Clearance kept above each obstacle, in px.
 * @returns {number} Bottom boundary in px.
 */
export function resolveLeftStackBottomBoundary({
  baseBottom,
  obstacles = [],
  safeGap = 0,
}) {
  let bottom = Number(baseBottom) || 0;
  const gap = Number(safeGap) || 0;
  for (const obstacle of obstacles) {
    const top = Number(obstacle?.top);
    if (!Number.isFinite(top)) continue;
    bottom = Math.min(bottom, top - gap);
  }
  return bottom;
}

/**
 * Returns later expanded panels whose allocation would expose less than the
 * requested share of their intrinsic height. The first panel always remains
 * expanded so every lane keeps one useful primary surface.
 *
 * @param {object} input Panel height measurements.
 * @param {number[]} input.naturalHeights Intrinsic expanded heights.
 * @param {number[]} input.allocatedHeights Allocated expanded heights.
 * @param {number} [input.minimumVisibleRatio=0.5] Minimum useful height share.
 * @param {boolean} [input.collapseLaterPanels=false] Collapse every competitor after the primary panel.
 * @returns {number[]} Candidate indices to present as collapsed controls.
 */
export function panelStackAutoCollapseIndices({
  naturalHeights,
  allocatedHeights,
  minimumVisibleRatio = 0.5,
  collapseLaterPanels = false,
}) {
  const threshold = Math.max(0, Number(minimumVisibleRatio) || 0);
  const collapsed = [];
  for (let index = 1; index < naturalHeights.length; index += 1) {
    if (collapseLaterPanels) {
      collapsed.push(index);
      continue;
    }
    const natural = Math.max(0, Number(naturalHeights[index]) || 0);
    const allocated = Math.max(0, Number(allocatedHeights[index]) || 0);
    if (natural > 0 && allocated / natural < threshold) collapsed.push(index);
  }
  return collapsed;
}

/**
 * Balance a desktop panel corridor around the viewport midpoint without
 * crossing its measured obstacle boundaries. If centering would shrink the
 * lane below its usable minimum, retain the original aligned corridor.
 *
 * @param {object} input Corridor measurements.
 * @param {number} input.viewportHeight Current viewport height.
 * @param {number} input.safeTop Proposed corridor top.
 * @param {number} input.safeBottom Proposed corridor bottom.
 * @param {number} input.obstacleSafeTop Highest obstacle-safe top boundary.
 * @param {number} input.obstacleSafeBottom Lowest obstacle-safe bottom boundary.
 * @param {number} input.minimumHeight Minimum useful lane height.
 * @returns {{ safeTop: number, safeBottom: number }} Bounded corridor.
 */
export function resolvePanelStackCorridor({
  viewportHeight,
  safeTop,
  safeBottom,
  obstacleSafeTop,
  obstacleSafeBottom,
  minimumHeight,
}) {
  const height = Math.max(1, Number(viewportHeight) || 1);
  const boundaryTop = Math.max(0, Number(obstacleSafeTop) || 0);
  const boundaryBottom = Math.max(
    boundaryTop,
    Math.min(height, Number(obstacleSafeBottom) || 0),
  );
  let top = Math.max(boundaryTop, Math.min(boundaryBottom, Number(safeTop) || 0));
  let bottom = Math.max(top, Math.min(boundaryBottom, Number(safeBottom) || 0));
  const minimum = Math.max(0, Number(minimumHeight) || 0);
  const midpoint = height * 0.5;

  if (top < midpoint && bottom > midpoint) {
    const centeredHalfHeight = Math.min(midpoint - top, bottom - midpoint);
    const centeredTop = midpoint - centeredHalfHeight;
    const centeredBottom = midpoint + centeredHalfHeight;
    if (centeredBottom - centeredTop >= minimum) {
      top = centeredTop;
      bottom = centeredBottom;
    }
  }

  if (bottom - top < minimum) {
    top = Math.max(boundaryTop, bottom - minimum);
    bottom = Math.min(boundaryBottom, Math.max(bottom, top + minimum));
  }

  return { safeTop: top, safeBottom: bottom };
}

/**
 * Estimates an expanded left-stack panel's unconstrained content height from its
 * direct children and their scroll extents. This avoids treating a flex-grown
 * panel as naturally tall while still accounting for nested lists.
 * @param {HTMLElement} panel Expanded accordion panel.
 * @param {object} [options]
 * @param {(element: Element) => CSSStyleDeclaration} [options.getStyle] getComputedStyle in the page; a fake in tests.
 * @returns {number} Natural height in rendered CSS pixels.
 */
export function measureLeftPanelNaturalHeight(panel, { getStyle = (element) => getComputedStyle(element) } = {}) {
  const inner = [...panel.children].find((child) => !child.classList.contains('panel-glow'));
  if (!inner) return Math.ceil(panel.scrollHeight || panel.getBoundingClientRect().height);

  const innerRect = inner.getBoundingClientRect();
  const panelStyle = getStyle(panel);
  const innerStyle = getStyle(inner);
  const paddingBottom = parseFloat(innerStyle.paddingBottom) || 0;
  let contentBottom = parseFloat(innerStyle.paddingTop) || 0;
  const wrapperChrome = (parseFloat(panelStyle.borderTopWidth) || 0)
    + (parseFloat(panelStyle.borderBottomWidth) || 0)
    + (parseFloat(panelStyle.paddingTop) || 0)
    + (parseFloat(panelStyle.paddingBottom) || 0);
  // R9-I1: a panel that is itself visibility: hidden (the data panel without .active, which the F key toggles; every panel in clean view)
  // draws nothing, and its children inherit hidden. It measures as its padding and wrapper chrome only, as before round 9: measured in
  // full, a hidden data panel took the whole left lane (3,286 px at 1400x900) and focus mode hid the collapsed SCENE and SPECIES pills.
  // R10-I1: the lane measures a panel by the visibility it is going to. Computed visibility changes at a transition's visible end: a panel
  // being shown reads hidden as its transition starts, when the class change's pass runs, and a hiding panel reads visible until its
  // transition ends, when the transitionend pass runs. So a panel reading hidden with a running visibility transition is being shown and is
  // measured in full; taken as hidden, the data panel faded in 26 px tall beside the SCENE and SPECIES pills, then snapped to full height.
  const beingShown = panelStyle.visibility === 'hidden'
    && panel.getAnimations().some((animation) => animation.transitionProperty === 'visibility' && animation.playState === 'running');
  if (panelStyle.visibility === 'hidden' && !beingShown) return Math.ceil(contentBottom + paddingBottom + wrapperChrome);

  for (const child of inner.children) {
    const childStyle = getStyle(child);
    // A visibility: hidden child of a visible panel still takes its layout space (the SPECIES panel's scroll cue is hidden while nothing is below), so only
    // display: none is left out; skipping hidden children left the panel short by that child, and its body overflowed.
    if (childStyle.display === 'none') continue;
    const childRect = child.getBoundingClientRect();
    const marginBottom = parseFloat(childStyle.marginBottom) || 0;
    const naturalChildHeight = Math.max(childRect.height, child.scrollHeight || 0);
    const childBottom = childRect.top - innerRect.top + naturalChildHeight + marginBottom;
    contentBottom = Math.max(contentBottom, childBottom);
  }

  // contentBottom runs from the inner's border-box top, so it holds the inner's top border; the bottom border is added here. Without it a
  // panel with a bordered inner came out 1 px short, and the SPECIES body overflowed by 1 px on tall windows (I2).
  const borderBottom = parseFloat(innerStyle.borderBottomWidth) || 0;
  return Math.ceil(contentBottom + paddingBottom + borderBottom + wrapperChrome);
}
