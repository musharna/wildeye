/**
 * One raster drape at a time. Seven drapes stack on the globe and, past two,
 * the result is unreadable (panel audit 2026-09-11, W0-3 second half). Any
 * request that turns a drape ON — user click, voice, share-URL restore —
 * turns the other enabled drapes OFF. The most recent request wins; a share
 * link naming several drapes ends with the last one restored.
 *
 * Off-requests never cascade, so the disables issued here cannot re-enter.
 * While compare is on, its two sides are exempt from each other (`exempt`), never from a third drape.
 */
export function installDrapeExclusivity(dataManager, drapeIds, { exempt = () => null } = {}) {
  const ids = new Set(drapeIds);
  if (typeof dataManager?.subscribeVisibilityRequests !== 'function') {
    throw new Error('installDrapeExclusivity: dataManager lacks subscribeVisibilityRequests');
  }
  return dataManager.subscribeVisibilityRequests((change) => {
    if (change?.type !== 'visibility-requested' || !change.enabled || !ids.has(change.layerId)) return;
    const pair = exempt();
    const keep = pair && pair.includes(change.layerId) ? new Set(pair) : null;
    for (const other of ids) {
      if (other === change.layerId || keep?.has(other)) continue;
      if (dataManager.isEffectivelyEnabled?.(other) ?? dataManager.isEnabled(other)) {
        dataManager.setEnabled(other, false, { origin: 'programmatic' });
      }
    }
  });
}
