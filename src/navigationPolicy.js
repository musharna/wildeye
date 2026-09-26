/**
 * Camera-ownership policy for explicit and deferred navigation.
 *
 * Immediate destinations stamp, release, and fly. Deferred destinations stamp
 * without releasing; after resolution they must recheck the stamp immediately
 * before releasing and flying.
 */

/**
 * Run an immediate explicit camera navigation.
 * @param {Object} options
 * @returns {*} Navigation result, or false when disposed.
 */
export function runExplicitNavigation({ disposed = false, stamp, release, navigate } = {}) {
  if (disposed) return false;
  const generation = stamp?.();
  release?.();
  return navigate?.(generation);
}

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
