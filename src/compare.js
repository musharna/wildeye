/**
 * Swipe compare: two raster drapes side by side behind a divider (GIBS stage 2, grill Q5/A6/A15).
 * Rendering is Cesium's own split (ImageryLayer.splitDirection + scene.splitPosition); this module
 * owns only which drape is on which side and where the divider sits. It ends itself whenever
 * either side goes off — by hand, by a third drape (drapeExclusive.js), or by failing to enable —
 * so the globe is never left half-split over one layer.
 */
import { LAYER_STATE_REGISTRY } from './data/layerState.js';

/** Cesium.SplitDirection values (pinned against Cesium in compare.test.mjs). */
export const SPLIT = Object.freeze({ LEFT: -1, NONE: 0, RIGHT: 1 });

export function createCompare({
  dataManager,
  drapeIds,
  setSplit,
  setPosition,
}) {
  const ids = new Set(drapeIds);
  const listeners = new Set();
  let state = null;
  const emit = () => {
    const s = state && { ...state };
    for (const fn of listeners) fn(s);
  };
  const end = () => {
    const s = state;
    if (!s) return;
    state = null;
    setSplit(s.left, SPLIT.NONE);
    setSplit(s.right, SPLIT.NONE);
    emit();
  };
  dataManager.subscribe((change) => {
    if (change?.type !== 'visibility' || change.enabled || !state) return;
    if (change.layerId === state.left || change.layerId === state.right) end();
  });

  return {
    exempt: () => (state ? [state.left, state.right] : null),
    getState: () => (state ? { ...state } : null),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async set(left, right, position = state?.position ?? 0.5) {
      for (const id of [left, right])
        if (!ids.has(id)) throw new Error(`compare: '${id}' is not a drape`);
      if (left === right) throw new Error(`compare: both sides are '${left}'`);
      if (!(Number.isFinite(position) && position >= 0 && position <= 1))
        throw new Error(`compare: position ${position} is outside 0..1`);
      const prev = state;
      if (prev)
        for (const id of [prev.left, prev.right])
          if (id !== left && id !== right) setSplit(id, SPLIT.NONE);
      const next = { left, right, position };
      state = next; // before enabling: exclusivity reads exempt() inside setEnabled
      setSplit(left, SPLIT.LEFT);
      setSplit(right, SPLIT.RIGHT);
      setPosition(position);
      emit();
      // A failed enable resolves (manager.js finishFailedEnable) with the layer still off; it does not throw.
      await dataManager.setEnabled(left, true, { origin: 'user' });
      await dataManager.setEnabled(right, true, { origin: 'user' });
      if (state !== next) return; // superseded by a newer set/off, or a side went off meanwhile
      const dead = [left, right].filter((id) => !dataManager.isEnabled(id));
      if (dead.length) {
        end(); // the side that did enable stays on, full-globe: it was exempt, so nothing turned it off
        throw new Error(
          `compare: ${dead.map((id) => `'${id}'`).join(' and ')} did not enable`,
        );
      }
    },

    move(p) {
      if (!state) return;
      state.position = Math.min(1, Math.max(0, Number(p) || 0));
      setPosition(state.position);
      emit();
    },

    async off() {
      const s = state;
      if (!s) return;
      end();
      await dataManager.setEnabled(s.right, false, { origin: 'user' });
    },
  };
}

const TOKEN_OF = new Map(LAYER_STATE_REGISTRY.map((e) => [e.id, e.token]));
const ID_OF = new Map(LAYER_STATE_REGISTRY.map((e) => [e.token, e.id]));

/** `cmp` share-link value for an active compare, or null when off. */
export function encodeCompareParam(state) {
  if (!state) return null;
  const [l, r] = [TOKEN_OF.get(state.left), TOKEN_OF.get(state.right)];
  if (!l || !r)
    throw new Error(
      `compare: no share token for '${l ? state.right : state.left}'`,
    );
  return `${l}.${r}.${Math.round(state.position * 100)}`;
}

/** Parse `cmp`; null when absent, throws (naming the raw value) when it cannot be a compare of two drapes. */
export function decodeCompareParam(raw, drapeIds) {
  if (raw == null || raw === '') return null;
  const m = /^([a-z0-9]{1,2})\.([a-z0-9]{1,2})\.(\d{1,3})$/.exec(raw);
  const bad = (why) => new Error(`compare: cmp='${raw}' ${why}`);
  if (!m) throw bad('is not <token>.<token>.<percent>');
  const [left, right] = [ID_OF.get(m[1]), ID_OF.get(m[2])];
  const drapes = new Set(drapeIds);
  if (!drapes.has(left) || !drapes.has(right))
    throw bad('names a layer that is not a drape');
  if (left === right) throw bad('names the same drape twice');
  const pct = Number(m[3]);
  if (pct > 100) throw bad('has a position over 100');
  return { left, right, position: pct / 100 };
}
