/**
 * Fix round 4 (critic r3 S1', S3, N1, N2): on a short viewport (SHORT_VIEWPORT_QUERY, the one condition style.css uses for the same regions) the
 * screen is three regions that never overlap: the left stack (a column of collapsed pills, or one open panel), the details card (the column
 * right of the pills, from under the header down to above the time bar), and the pick target (the globe's centre, which the "Click a spot" card,
 * top-anchored and 75 px tall, stays above). An open panel and the card cannot both fit beside each other, so they take turns:
 * - the card showing folds the open panel (focus that was inside it moves to the card's close button, so the keyboard is not left on BODY);
 * - the card closing (a cancel, the ×, Escape) opens that panel again and puts focus back where it was (WHAT LIVES HERE after a cancelled pick);
 * - a panel opened while the card shows (one tap on a pill, results showing) closes the card.
 * On taller viewports nothing here acts: the regions do not meet there.
 */
// Fix round 5: 600 px, not 480. At the heights between, the desktop lane engine (ui.js) gives an open left panel 35 px at 500-520 px, 98-164 px at
// 530-600 px (measured at 1024 and 1400 px wide), less than the ~186 px the SPECIES controls need (search, status, chosen row, WHAT LIVES HERE).
// Landscape only: a portrait phone this short (320x568) keeps the portrait layout, where the stack and the card already stack vertically.
export const SHORT_VIEWPORT_QUERY = '(max-height: 600px) and (orientation: landscape)';

export function createShortViewportRegions({
  isShort = () => window.matchMedia(SHORT_VIEWPORT_QUERY).matches,
  stack,
  cardElement,
  dismissCard,
  setPanelCollapsed,
  doc = document,
  observe = (onMutations) => {
    const observer = new MutationObserver(onMutations);
    observer.observe(cardElement, { attributes: true, attributeFilter: ['hidden'] });
    for (const panel of stack.querySelectorAll(':scope > [data-panel-id]')) observer.observe(panel, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    return () => observer.disconnect();
  },
}) {
  let folded = null; // { id, focus }: the panel folded for the card, and the element that had focus then
  let restoring = false;
  const panels = () => [...stack.querySelectorAll(':scope > [data-panel-id]')];
  const cardShown = () => !cardElement.hidden;

  const onCardChange = () => {
    if (cardShown()) {
      if (!isShort() || folded) return;
      const open = panels().find((panel) => !panel.classList.contains('collapsed'));
      if (!open) return;
      const focus = doc.activeElement;
      const focusInside = Boolean(focus && open.contains(focus));
      folded = { id: open.id, focus: focusInside ? focus : null };
      setPanelCollapsed(open.id, true);
      if (focusInside) cardElement.querySelector('.bio-card-close')?.focus();
      return;
    }
    const was = folded;
    folded = null;
    if (!was) return;
    const panel = panels().find((p) => p.id === was.id);
    if (panel && panel.classList.contains('collapsed')) {
      restoring = true;
      try { setPanelCollapsed(was.id, false); } finally { restoring = false; }
    }
    const active = doc.activeElement;
    if (was.focus?.isConnected && (!active || active === doc.body || cardElement.contains(active))) was.focus.focus();
  };

  const onPanelChange = (panel, oldValue) => {
    const opened = String(oldValue || '').split(/\s+/).includes('collapsed') && !panel.classList.contains('collapsed');
    if (!opened || restoring || !isShort() || !cardShown()) return;
    folded = null; // the person chose a panel: nothing to give back when the card goes
    dismissCard();
  };

  const stop = observe((mutations) => {
    for (const m of mutations) {
      if (m.target === cardElement) onCardChange();
      else if (m.attributeName === 'class') onPanelChange(m.target, m.oldValue);
    }
  });
  return { stop: typeof stop === 'function' ? stop : () => {} };
}

/** The selector of the header boxes the short-viewport columns keep clear of: the title, its tagline and the top-centre buttons. */
export const SHORT_HEADER_SELECTOR = '#title-bar h1, #title-bar .subtitle, #top-center-actions';

/**
 * Fix round 6 (critic r5 S1): where a column running from `left` to `right` can start: 8 px below the lowest header box over it (a non-empty box
 * in the top half of the viewport that overlaps the column horizontally), or 0 when none is. Measured from the page's real header, so it
 * holds as the title grows with the window (at 844x390 the tagline ends near y 96, and a stack at 70 covered it).
 */
export function topBelowHeader({ boxes, left, right, viewportHeight, gap = 8 }) {
  let bottom = null;
  for (const b of boxes) {
    if (!(b.width > 0 && b.height > 0) || b.top >= viewportHeight / 2) continue;
    if (b.right <= left || b.left >= right) continue;
    bottom = Math.max(bottom ?? -Infinity, b.bottom);
  }
  return bottom === null ? 0 : Math.ceil(bottom + gap);
}
