/**
 * Fix round 3 (critic r2 S1): while WHAT LIVES HERE waits for a click, the globe's centre (the spot under the camera, where a pick most often
 * goes) must not be under an open left-stack panel. In phone landscape the open stack is 460 x 178 px and covered it. The panel that covers
 * the centre collapses when the pick is armed. It comes back when the pick is cancelled (Escape, the card closed), since the person then
 * returns to what they were doing; after a pick it stays collapsed, because the results card opens in the same part of the screen and the
 * SPECIES pill is one tap away. Where no open panel covers the centre (portrait phones, desktop) nothing moves.
 */
export function createPickClearance({ stack, canvas, setPanelCollapsed }) {
  let cleared = null;
  const coversCentre = (panel) => {
    const c = canvas.getBoundingClientRect();
    const x = c.left + c.width / 2;
    const y = c.top + c.height / 2;
    const r = panel.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  return {
    /** Wire to createWhatLivesHere's onArmedChange(armed, reason): reason is 'arm', 'pick' or 'cancel'. */
    onArmedChange(armed, reason) {
      if (armed) {
        const panel = [...stack.querySelectorAll(':scope > [data-panel-id]')].find((p) => !p.classList.contains('collapsed') && coversCentre(p));
        cleared = panel ? panel.id : null;
        if (panel) setPanelCollapsed(panel.id, true);
        return;
      }
      const id = cleared;
      cleared = null;
      if (id === null || reason !== 'cancel') return;
      const panel = [...stack.querySelectorAll(':scope > [data-panel-id]')].find((p) => p.id === id);
      if (panel && panel.classList.contains('collapsed')) setPanelCollapsed(id, false);
    },
  };
}
