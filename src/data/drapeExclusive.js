/**
 * One raster drape at a time. Seven drapes stack on the globe and, past two,
 * the result is unreadable (panel audit 2026-09-11, W0-3 second half). Any
 * request that turns a drape ON — user click, voice, share-URL restore —
 * turns the other enabled drapes OFF. The most recent request wins; a share
 * link naming several drapes ends with the last one restored.
 *
 * Off-requests never cascade, so the disables issued here cannot re-enter.
 */
export function installDrapeExclusivity(dataManager, drapeIds) {
  const ids = new Set(drapeIds);
  if (typeof dataManager?.subscribeVisibilityRequests !== 'function') {
    throw new Error('installDrapeExclusivity: dataManager lacks subscribeVisibilityRequests');
  }
  return dataManager.subscribeVisibilityRequests((change) => {
    if (change?.type !== 'visibility-requested' || !change.enabled || !ids.has(change.layerId)) return;
    for (const other of ids) {
      if (other === change.layerId) continue;
      if (dataManager.isEffectivelyEnabled?.(other) ?? dataManager.isEnabled(other)) {
        dataManager.setEnabled(other, false, { origin: 'programmatic' });
      }
    }
  });
}
