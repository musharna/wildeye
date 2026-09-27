/**
 * Camera-ownership policy for deferred navigation (the share-link restore
 * flight). A deferred destination stamps without releasing; when it resolves it
 * must recheck the stamp immediately before releasing and flying.
 */

/**
 * Accept a deferred navigation intent without releasing the current owner.
 * @param {Object} options
 * @returns {number|false} Generation stamp, or false when disposed.
 */
export function beginDeferredNavigation({ disposed = false, stamp } = {}) {
  if (disposed) return false;
  return stamp?.();
}

/**
 * Re-assert authority immediately before a deferred flight.
 * @param {Object} options
 * @returns {boolean} Whether the deferred flight still owns the camera.
 */
export function reassertNavigationHandoff({ generation, currentGeneration, disposed = false, release } = {}) {
  if (disposed || generation !== currentGeneration) return false;
  release?.();
  return true;
}
