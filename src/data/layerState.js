const VALID_DISPOSITIONS = new Set([
  'enabled-only',
  'enabled+options',
  'enabled+mirrored-options',
]);

export const LAYER_STATE_VERSION = 2;
/**
 * Ceilings for the untrusted v2 layer fields. Both are far above any legitimate
 * payload (a few dozen one- or two-character tokens; a dozen short option assignments), so a
 * value past them is malformed or hostile. Reject the WHOLE payload, matching
 * the unknown-token rule — never salvage a prefix.
 */
// 36 one-char tokens ran out at 35 layers (2026-09-12); tokens are dot-separated so a
// second character is free. 128 chars holds ~45 two-char tokens with separators.
const MAX_ENABLED_LAYERS_CHARS = 128;
const MAX_LAYER_OPTIONS_CHARS = 512;
export const LAYER_STATE_STORAGE_KEY = 'gev:layer-state:v2';
export const LAYER_RESTORE_ORIGINS = Object.freeze({
  share: 'share-restore',
  local: 'local-restore',
});

function normalizeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeEnum(values, value) {
  return values.includes(value) ? value : null;
}

function booleanOption(key, token, defaultValue) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: normalizeBoolean,
    encode: (value) => (value ? '1' : '0'),
    decode: (value) => (value === '1' ? true : value === '0' ? false : null),
  });
}

function enumOption(key, token, defaultValue, values, codes) {
  const reverse = Object.fromEntries(Object.entries(codes).map(([name, code]) => [code, name]));
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: (value) => normalizeEnum(values, value),
    encode: (value) => codes[value],
    decode: (value) => reverse[value] || null,
  });
}

function integerOption(key, token, defaultValue) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: (value) => {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
      const candidate = typeof value === 'string' ? value.trim() : '';
      const parsed = Number(candidate);
      if (!candidate || !Number.isInteger(parsed) || parsed <= 0) return null;
      return parsed;
    },
    encode: (value) => String(Math.trunc(value)),
    decode: (value) => {
      const candidate = Number(value);
      if (!Number.isInteger(candidate) || candidate <= 0) return null;
      return candidate;
    },
  });
}

const OPTION_GROUPS = Object.freeze({
  birds: Object.freeze([
    booleanOption('columns', 'c', false),
    booleanOption('drape', 'd', true),
    booleanOption('particles', 'p', true),
  ]),
  species: Object.freeze([
    integerOption('taxonKey', 'k', null),
    enumOption('years', 'y', 'recent', ['recent', 'all'], { recent: 'r', all: 'a' }),
    Object.freeze({
      key: 'radiusKm',
      token: 'r',
      defaultValue: 10,
      // Numeric, so not enumOption: its reverse map would decode '50' as the string '50', which the
      // enum then rejects, silently turning every shared 50 km link into 10 km.
      normalize: (value) => ([1, 10, 50].includes(value) ? value : null),
      encode: (value) => String(value),
      decode: (value) => {
        const km = Number(value);
        return [1, 10, 50].includes(km) ? km : null;
      },
    }),
  ]),
});

/**
 * Canonical serialization registry. Its order, not runtime registration order,
 * owns stable URL ordering.
 */
export const LAYER_STATE_REGISTRY = Object.freeze([
  Object.freeze({ id: 'aloft', token: 'k', disposition: 'enabled-only' }),
  Object.freeze({ id: 'arbonet', token: 'ar', disposition: 'enabled-only' }),
  Object.freeze({ id: 'bii', token: 'bi', disposition: 'enabled-only' }),
  Object.freeze({ id: 'biotime', token: 'bt', disposition: 'enabled-only' }),
  Object.freeze({ id: 'birds', token: 'n', disposition: 'enabled+options', optionOwner: 'birds' }),
  Object.freeze({ id: 'camera-traps', token: 'ct', disposition: 'enabled-only' }),
  Object.freeze({ id: 'cetaceans', token: 'ce', disposition: 'enabled-only' }),
  Object.freeze({ id: 'chlor-a', token: 'v', disposition: 'enabled-only' }),
  Object.freeze({ id: 'cmems-o2', token: '7', disposition: 'enabled-only' }),
  Object.freeze({ id: 'cmems-pft', token: 'pf', disposition: 'enabled-only' }),
  Object.freeze({ id: 'cmems-ph', token: '8', disposition: 'enabled-only' }),
  Object.freeze({ id: 'cmems-zooc', token: 'zc', disposition: 'enabled-only' }),
  Object.freeze({ id: 'crw-bleaching', token: 'h', disposition: 'enabled-only' }),
  Object.freeze({ id: 'crw-dhw', token: 'y', disposition: 'enabled-only' }),
  Object.freeze({ id: 'crw-hotspot', token: 'p', disposition: 'enabled-only' }),
  Object.freeze({ id: 'crw-outlook', token: 'bo', disposition: 'enabled-only' }),
  Object.freeze({ id: 'crw-seaice', token: 'l', disposition: 'enabled-only' }),
  Object.freeze({ id: 'drought', token: 'dr', disposition: 'enabled-only' }),
  Object.freeze({ id: 'ecoregions', token: 'ec', disposition: 'enabled-only' }),
  Object.freeze({ id: 'edna', token: 'dn', disposition: 'enabled-only' }),
  Object.freeze({ id: 'fires', token: 'fi', disposition: 'enabled-only' }),
  Object.freeze({ id: 'freshwater-fish', token: 'ff', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gfw', token: '6', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-amphibians', token: 'am', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-anthromes', token: 'ab', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-biomass', token: 'gd', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-canopy', token: 'ch', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-evi', token: 'ev', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-gpp', token: 'gp', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-landcover', token: 'lc', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-lst', token: 'ls', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-mammals', token: 'mm', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gibs-nightlights', token: 'bm', disposition: 'enabled-only' }),
  Object.freeze({ id: 'gmw', token: 'mg', disposition: 'enabled-only' }),
  Object.freeze({ id: 'griis', token: 'gr', disposition: 'enabled-only' }),
  Object.freeze({ id: 'h5n1', token: 'h5', disposition: 'enabled-only' }),
  Object.freeze({ id: 'haedat', token: 'ha', disposition: 'enabled-only' }),
  Object.freeze({ id: 'hansen-loss', token: 'hl', disposition: 'enabled-only' }),
  Object.freeze({ id: 'hotspots', token: 'hs', disposition: 'enabled-only' }),
  Object.freeze({ id: 'hpai', token: '4', disposition: 'enabled-only' }),
  Object.freeze({ id: 'human-footprint', token: 'hf', disposition: 'enabled-only' }),
  Object.freeze({ id: 'ifl', token: 'if', disposition: 'enabled-only' }),
  Object.freeze({ id: 'kelp', token: 'kp', disposition: 'enabled-only' }),
  Object.freeze({ id: 'malaria', token: 'ml', disposition: 'enabled-only' }),
  Object.freeze({ id: 'mammals', token: 'md', disposition: 'enabled-only' }),
  Object.freeze({ id: 'marine-realms', token: 'mr', disposition: 'enabled-only' }),
  Object.freeze({ id: 'natural-lands', token: 'nl', disposition: 'enabled-only' }),
  Object.freeze({ id: 'ndvi', token: '0', disposition: 'enabled-only' }),
  Object.freeze({ id: 'neon', token: '5', disposition: 'enabled-only' }),
  Object.freeze({ id: 'neon-vectors', token: 'nv', disposition: 'enabled-only' }),
  Object.freeze({ id: 'obis-grid', token: 'ob', disposition: 'enabled-only' }),
  Object.freeze({ id: 'occurrences', token: 'o', disposition: 'enabled-only' }),
  Object.freeze({ id: 'oisst', token: 'j', disposition: 'enabled-only' }),
  Object.freeze({ id: 'otn', token: '3', disposition: 'enabled-only' }),
  Object.freeze({ id: 'penguins', token: 'pg', disposition: 'enabled-only' }),
  Object.freeze({ id: 'phenology', token: 'ph', disposition: 'enabled-only' }),
  Object.freeze({ id: 'plants-wcvp', token: 'vp', disposition: 'enabled-only' }),
  Object.freeze({ id: 'protected-areas', token: 'pa', disposition: 'enabled-only' }),
  Object.freeze({ id: 'reptiles', token: 'rp', disposition: 'enabled-only' }),
  Object.freeze({ id: 'rivers', token: 'rv', disposition: 'enabled-only' }),
  Object.freeze({ id: 'seagrass', token: 'sg', disposition: 'enabled-only' }),
  Object.freeze({ id: 'soil-bacteria', token: 'sb', disposition: 'enabled-only' }),
  Object.freeze({ id: 'species', token: 'sp', disposition: 'enabled+options', optionOwner: 'species' }),
  Object.freeze({ id: 'surface-water', token: 'sw', disposition: 'enabled-only' }),
  Object.freeze({ id: 'tidal-marsh', token: 'tm', disposition: 'enabled-only' }),
  Object.freeze({ id: 'tracks', token: '1', disposition: 'enabled-only' }),
  Object.freeze({ id: 'wastewater', token: '2', disposition: 'enabled-only' }),
  Object.freeze({ id: 'wetlands', token: 'wl', disposition: 'enabled-only' }),
  Object.freeze({ id: 'whispers', token: '9', disposition: 'enabled-only' }),
]);

/**
 * Tokens of the God's Eye layers removed on 2026-09-26. Links made before then can carry them, and one
 * unknown token rejects a link's whole layer payload, so decoding drops these and keeps the rest. They
 * are never reissued: a reused token would switch on a different layer in an old link.
 */
const RETIRED_LAYER_TOKENS = Object.freeze(new Set([
  'a', // ais-live-vessels
  'b', // bikeshare
  'c', // cctv
  'e', // earthquakes
  'f', // flights
  'q', // local-dams
  'd', // local-datacenters
  'w', // local-firms
  'm', // military
  'g', // military-awareness
  'i', // military-installations
  'r', // radio
  'x', // rocket-launches
  's', // satellites
  'u', // telegeography-submarine-cables
  't', // traffic
]));

export const REGISTERED_LAYER_IDS = Object.freeze(LAYER_STATE_REGISTRY.map((entry) => entry.id));

const REGISTRY_BY_ID = new Map(LAYER_STATE_REGISTRY.map((entry) => [entry.id, entry]));
const REGISTRY_BY_TOKEN = new Map(LAYER_STATE_REGISTRY.map((entry) => [entry.token, entry]));
const OPTION_OWNER_IDS = Object.freeze([...new Set(
  LAYER_STATE_REGISTRY.map((entry) => entry.optionOwner).filter(Boolean),
)]);

function optionSpecs(ownerId) {
  return OPTION_GROUPS[ownerId] || [];
}

function defaultsForOwner(ownerId) {
  return Object.fromEntries(optionSpecs(ownerId).map((spec) => [spec.key, spec.defaultValue]));
}

function normalizeOwnerOptions(ownerId, candidate = {}) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const normalized = {};
  for (const spec of optionSpecs(ownerId)) {
    const value = Object.hasOwn(input, spec.key) ? spec.normalize(input[spec.key]) : null;
    normalized[spec.key] = value === null ? spec.defaultValue : value;
  }
  return normalized;
}

/** Return whether an event origin represents durable direct intent. */
export function isExplicitLayerStateOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

/** Validate the static registry itself before it is used to seal a manager. */
export function validateLayerStateRegistry(registry = LAYER_STATE_REGISTRY) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error('Layer-state registry must be a non-empty array');
  }
  const ids = new Set();
  const tokens = new Set();
  for (const entry of registry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) throw new Error('Layer-state entry missing id');
    if (!/^[a-z0-9-]+$/.test(entry.id)) throw new Error(`Invalid layer-state id: ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate layer-state id: ${entry.id}`);
    ids.add(entry.id);
    if (!/^[a-z0-9]{1,2}$/.test(entry.token || '')) throw new Error(`Invalid layer-state token: ${entry.id}`);
    if (tokens.has(entry.token)) throw new Error(`Duplicate layer-state token: ${entry.token}`);
    tokens.add(entry.token);
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      throw new Error(`Invalid layer-state disposition: ${entry.id}`);
    }
    if (entry.disposition !== 'enabled-only') {
      if (!entry.optionOwner || optionSpecs(entry.optionOwner).length === 0) {
        throw new Error(`Layer-state option owner missing: ${entry.id}`);
      }
    } else if (entry.optionOwner) {
      throw new Error(`Enabled-only layer cannot own options: ${entry.id}`);
    }
  }
  return true;
}

validateLayerStateRegistry();

/** Produce the complete durable default state. */
export function createDefaultLayerState() {
  return {
    version: LAYER_STATE_VERSION,
    enabledLayerIds: [],
    options: Object.fromEntries(OPTION_OWNER_IDS.map((ownerId) => [
      ownerId,
      defaultsForOwner(ownerId),
    ])),
  };
}

/** Sanitize and canonicalize an externally supplied layer-state object. */
export function normalizeLayerState(candidate) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const requestedEnabled = new Set(
    Array.isArray(input.enabledLayerIds) ? input.enabledLayerIds.map(String) : [],
  );
  const enabledLayerIds = REGISTERED_LAYER_IDS.filter((id) => requestedEnabled.has(id));
  const options = Object.fromEntries(OPTION_OWNER_IDS.map((ownerId) => [
    ownerId,
    normalizeOwnerOptions(ownerId, input.options?.[ownerId]),
  ]));
  return {
    version: LAYER_STATE_VERSION,
    enabledLayerIds,
    options,
  };
}

export function cloneLayerState(state) {
  const normalized = normalizeLayerState(state);
  return {
    ...normalized,
    enabledLayerIds: [...normalized.enabledLayerIds],
    options: Object.fromEntries(
      Object.entries(normalized.options).map(([id, options]) => [id, { ...options }]),
    ),
  };
}

/** Append the compact v2 layer fields to an existing URLSearchParams object. */
export function encodeLayerStateParams(params, state) {
  const normalized = normalizeLayerState(state);
  const enabled = new Set(normalized.enabledLayerIds);
  params.set('l', LAYER_STATE_REGISTRY
    .filter((entry) => enabled.has(entry.id))
    .map((entry) => entry.token)
    .join('.'));
  const encodedOptions = [];
  for (const ownerId of OPTION_OWNER_IDS) {
    const ownerEntry = REGISTRY_BY_ID.get(ownerId);
    const ownerOptions = normalized.options[ownerId];
    for (const spec of optionSpecs(ownerId)) {
      if (ownerOptions[spec.key] === spec.defaultValue) continue;
      encodedOptions.push(`${ownerEntry.token}.${spec.token}.${spec.encode(ownerOptions[spec.key])}`);
    }
  }
  if (encodedOptions.length) params.set('lo', encodedOptions.join('_'));
  else params.delete('lo');
  return params;
}

/** Decode v2 fields. Null means that the layer payload is absent. */
export function decodeLayerStateParams(params) {
  if (params.get('v') !== String(LAYER_STATE_VERSION) || !params.has('l')) return null;
  const rawLayers = String(params.get('l') || '');
  const rawOptionsField = String(params.get('lo') || '');
  // Fail closed on an oversized payload rather than decoding a truncated one.
  if (rawLayers.length > MAX_ENABLED_LAYERS_CHARS) return null;
  if (rawOptionsField.length > MAX_LAYER_OPTIONS_CHARS) return null;
  const layerTokens = rawLayers.split('.').filter((token) => token && !RETIRED_LAYER_TOKENS.has(token));
  // `l=` is the one valid explicit-empty representation. Any non-empty token
  // set containing an unknown member rejects the complete layer payload so a
  // typo or future token cannot silently become an authoritative empty set.
  if (layerTokens.some((token) => !REGISTRY_BY_TOKEN.has(token))) return null;
  const enabledLayerIds = layerTokens.map((token) => REGISTRY_BY_TOKEN.get(token).id);
  const rawOptions = {};
  for (const assignment of rawOptionsField.split('_')) {
    if (!assignment) continue;
    const [layerToken, optionToken, encodedValue, ...extra] = assignment.split('.');
    if (extra.length) continue;
    const entry = REGISTRY_BY_TOKEN.get(layerToken);
    const ownerId = entry?.optionOwner || null;
    if (!ownerId) continue;
    const spec = optionSpecs(ownerId).find((candidate) => candidate.token === optionToken);
    if (!spec) continue;
    const decoded = spec.decode(encodedValue);
    if (decoded === null) continue;
    if (!rawOptions[ownerId]) rawOptions[ownerId] = {};
    rawOptions[ownerId][spec.key] = decoded;
  }
  return normalizeLayerState({ enabledLayerIds, options: rawOptions });
}

/** Stable local-storage representation (full IDs for debuggability). */
export function serializeStoredLayerState(state) {
  const normalized = normalizeLayerState(state);
  return JSON.stringify({
    v: LAYER_STATE_VERSION,
    l: normalized.enabledLayerIds,
    o: normalized.options,
  });
}

export function parseStoredLayerState(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== LAYER_STATE_VERSION || !Array.isArray(parsed.l)) return null;
    return normalizeLayerState({ enabledLayerIds: parsed.l, options: parsed.o });
  } catch {
    return null;
  }
}

/** Return sanitized options to apply to one registered module. */
export function layerOptionsForRestore(state, layerId) {
  const entry = REGISTRY_BY_ID.get(layerId);
  if (!entry?.optionOwner) return null;
  return { ...normalizeLayerState(state).options[entry.optionOwner] };
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function currentLayerOutcome(dataManager, layerId) {
  const state = dataManager.getLayerLifecycleState?.(layerId);
  return {
    settledEnabled: Boolean(state?.enabled),
    lifecycleState: state?.lifecycleState || 'missing',
    lifecycleUncertain: Boolean(state?.uncertain),
  };
}

/**
 * Owns durable user layer preferences independently from transient runtime
 * choreography, and coordinates passive post-registration restoration.
 */
export class LayerStateCoordinator {
  constructor(dataManager, shareLinkManager, {
    storage = safeStorage(),
    restoreGate = null,
    onDurableStateChange = null,
  } = {}) {
    if (!dataManager?.registrationsFinalized) {
      throw new Error('Layer state requires finalized data-layer registrations');
    }
    this.dataManager = dataManager;
    this.shareLinkManager = shareLinkManager || null;
    this.storage = storage;
    this.restoreGate = restoreGate;
    this.onDurableStateChange = onDurableStateChange;
    this._durableState = createDefaultLayerState();
    this._source = 'defaults';
    this._destroyed = false;
    this._restoreControllers = new Map();
    this._unsubscribe = this.dataManager.subscribe((change) => this._handleManagerChange(change));
    this._unsubscribeVisibilityRequests = this.dataManager.subscribeVisibilityRequests(
      (change) => this._handleVisibilityRequest(change),
    );
    this.restorePromise = Promise.resolve([]);
    this.lastRestoreResults = [];
  }

  start({ shareLayerState = null, allowLocalState = true } = {}) {
    if (this._destroyed) throw new Error('Layer-state coordinator is destroyed');
    let selected = shareLayerState ? normalizeLayerState(shareLayerState) : null;
    if (selected) {
      this._source = 'share';
    } else if (allowLocalState) {
      let stored = null;
      try { stored = parseStoredLayerState(this.storage?.getItem?.(LAYER_STATE_STORAGE_KEY)); } catch { /* best effort */ }
      if (stored) {
        selected = stored;
        this._source = 'local';
      }
    } else {
      // A valid historical camera/style share with no v2 layer payload keeps
      // the exact legacy default-layer behavior. It must not inherit an
      // unrelated recipient's saved local layer preferences.
      this._source = 'legacy-share';
    }
    this._durableState = selected || createDefaultLayerState();
    this.shareLinkManager?.setLayerStateProvider?.(() => this.getDurableState());
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
    if (!selected) return this.restorePromise;
    this.restorePromise = this._restoreSelectedState(
      this._source === 'share' ? LAYER_RESTORE_ORIGINS.share : LAYER_RESTORE_ORIGINS.local,
    );
    return this.restorePromise;
  }

  get source() {
    return this._source;
  }

  getDurableState() {
    return cloneLayerState(this._durableState);
  }

  _notifyDurableState() {
    try { this.onDurableStateChange?.(this.getDurableState()); } catch { /* UI sync is best effort */ }
  }

  _handleVisibilityRequest(change) {
    if (!isExplicitLayerStateOrigin(change?.origin)) return;
    this._restoreControllers.get(change.layerId)?.abort('superseded-by-explicit-visibility');
  }

  /** Revoke every passive restore before explicit navigation can be reclaimed. */
  cancelPendingRestores(reason = 'superseded-by-explicit-navigation') {
    for (const controller of this._restoreControllers.values()) controller.abort(reason);
  }

  _handleManagerChange(change) {
    if (!change || this._destroyed) return;
    // Parameter and visibility ownership are independent. A newer explicit
    // option request may replace passive share options, but it must not abort
    // the same layer's visibility lifecycle.
    if (change.type === 'params-requested') return;
    if (!isExplicitLayerStateOrigin(change.origin)) return;
    if (change.type === 'visibility') {
      this._restoreControllers.get(change.layerId)?.abort('superseded-by-explicit-visibility');
      const enabled = new Set(this._durableState.enabledLayerIds);
      if (change.enabled) enabled.add(change.layerId);
      else enabled.delete(change.layerId);
      this._commitExplicit({ ...this._durableState, enabledLayerIds: [...enabled] });
      return;
    }
    if (change.type !== 'params') return;
    const entry = REGISTRY_BY_ID.get(change.layerId);
    if (!entry?.optionOwner) return;
    const ownerId = entry.optionOwner;
    const nextOwnerOptions = { ...this._durableState.options[ownerId] };
    const requestedParams = change.requestedParams || {};
    let changed = false;
    for (const spec of optionSpecs(ownerId)) {
      // Only persist keys present in this explicit request. getLayerParams()
      // can return a wider live snapshot containing transient or passively
      // changed values that this user action did not own.
      if (!Object.hasOwn(requestedParams, spec.key)) continue;
      const value = spec.normalize(change.params[spec.key]);
      if (value === null && (spec.defaultValue !== null || change.params[spec.key] !== null)) continue;
      nextOwnerOptions[spec.key] = value;
      changed = true;
    }
    if (!changed) return;
    this._commitExplicit({
      ...this._durableState,
      options: { ...this._durableState.options, [ownerId]: nextOwnerOptions },
    });
  }

  _commitExplicit(candidate) {
    this._durableState = normalizeLayerState(candidate);
    const serialized = serializeStoredLayerState(this._durableState);
    try {
      if (this.storage?.getItem?.(LAYER_STATE_STORAGE_KEY) !== serialized) {
        this.storage?.setItem?.(LAYER_STATE_STORAGE_KEY, serialized);
      }
    } catch { /* storage can be unavailable or quota-limited */ }
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
  }

  async _waitForRestoreGate() {
    if (!this.restoreGate) return;
    await (typeof this.restoreGate === 'function' ? this.restoreGate() : this.restoreGate);
  }

  async _restoreSelectedState(origin) {
    for (const entry of LAYER_STATE_REGISTRY) {
      this._restoreControllers.set(entry.id, new AbortController());
    }
    try {
      await this._waitForRestoreGate();
      const enabled = new Set(this._durableState.enabledLayerIds);
      const settled = await Promise.allSettled(LAYER_STATE_REGISTRY.map(async (entry) => {
        const controller = this._restoreControllers.get(entry.id);
        const targetEnabled = enabled.has(entry.id);
        const options = layerOptionsForRestore(this._durableState, entry.id);
        if (this._destroyed || controller?.signal.aborted) {
          return {
            layerId: entry.id,
            targetEnabled,
            origin,
            phase: 'reserved',
            ...currentLayerOutcome(this.dataManager, entry.id),
            appliedOptions: {},
            cancellationReason: this._destroyed ? 'destroyed' : 'superseded',
            errorClass: 'cancelled',
            persistenceWrite: false,
            succeeded: false,
          };
        }
        // Reserve passive option state before any asynchronous lifecycle work.
        // A later explicit params intent then wins on its own lane without
        // cancelling or being overwritten by the visibility restore.
        const paramsSucceeded = !options || Object.keys(options).length === 0
          || this.dataManager.setLayerParams(entry.id, options, { origin });
        return this.dataManager.restoreLayerState(entry.id, {
          enabled: targetEnabled,
          params: null,
        }, { origin, signal: controller.signal }).then((result) => ({
          ...result,
          appliedOptions: paramsSucceeded && options ? options : {},
          errorClass: paramsSucceeded ? result.errorClass : 'ParamsRejected',
          succeeded: paramsSucceeded && result.succeeded,
        }));
      }));
      this.lastRestoreResults = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        const entry = LAYER_STATE_REGISTRY[index];
        return {
          layerId: entry.id,
          targetEnabled: enabled.has(entry.id),
          origin,
          phase: 'coordinator',
          ...currentLayerOutcome(this.dataManager, entry.id),
          appliedOptions: {},
          cancellationReason: null,
          errorClass: result.reason?.name || 'Error',
          error: String(result.reason?.message || result.reason),
          persistenceWrite: false,
          succeeded: false,
        };
      });
      return this.lastRestoreResults.map((result) => ({ ...result }));
    } finally {
      this._restoreControllers.clear();
      this._notifyDurableState();
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const controller of this._restoreControllers.values()) controller.abort('coordinator-destroyed');
    this._restoreControllers.clear();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubscribeVisibilityRequests?.();
    this._unsubscribeVisibilityRequests = null;
    this.shareLinkManager?.setLayerStateProvider?.(null);
    this.onDurableStateChange = null;
  }
}
