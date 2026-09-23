/**
 * Shared observed-time selector for the biological layers.
 *
 * One store holds the selected UTC instant (or null = live/latest). Layers that
 * implement `setObservedTime(iso|null)` sample their own data at that instant:
 * birds pick the nearest archived hourly frame, raster drapes the nearest
 * archived acquisition, sightings fade by age relative to it. Illustrative
 * particle motion and the Space Missions replay keep their own clocks — this
 * store coordinates *observation time*, not animation.
 *
 * The span the bar offers is NOT a constant here. It is the union of what the
 * enabled sampling layers say they can serve, each declaring its own extent
 * through `getObservedExtent()` — either a concrete `{startMs, endMs}` read off
 * the data it holds, or `{rollingDays}` when its pipeline keeps a rolling recent
 * window. A layer that declares nothing contributes nothing, and with no extents
 * at all the bar has no domain and stays hidden.
 *
 * This was `domainDays: 30` applied to `now`, invented here and never checked
 * against any layer. The birds replay archive is a fixed span written by a
 * backfill, so once it stopped advancing the bar advertised hours no frame
 * existed for — 12 of its 30 days by 2026-09-22 — while the oldest nights it did
 * hold had already fallen off the front of the window, and occurrences (which
 * reaches back to May) could not be scrubbed past 30 days at all. Two windows
 * specified independently drift apart. There is now one, and it is the data's.
 *
 * (Wave 0 item 5 of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md:
 * the birds replay was a layer-private frame-index widget.)
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function floorToHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}
export function isoHour(ms) {
  return new Date(floorToHour(ms))
    .toISOString()
    .replace(/:\d\d\.\d{3}Z$/, ":00Z");
}

/**
 * `stepMs` pins the slider's step; left out, it scales with the span (see stepFor).
 * @param {{stepMs?: number, now?: () => number,
 *   setInterval?: Function, clearInterval?: Function}} [opts]
 */
export function createObservedTime(opts = {}) {
  const now = opts.now || (() => Date.now());
  // The step is a property of the span, not a constant. tracks carries archived telemetry back to
  // 2009, so a fixed hourly step would put ~150,000 notches on the slider and make it unusable the
  // moment that layer is on; birds' frames are hourly and its archive is a month, where hourly is
  // exactly right. An explicit stepMs still wins, which is what the unit tests pin.
  const stepFor = (spanMs) => {
    if (opts.stepMs) return opts.stepMs;
    if (spanMs <= 60 * DAY_MS) return HOUR_MS;
    if (spanMs <= 6 * 365 * DAY_MS) return DAY_MS;
    return 7 * DAY_MS;
  };
  const setI = opts.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearI = opts.clearInterval || ((h) => clearInterval(h));
  const listeners = new Set();
  /** layerId -> {startMs, endMs} | {rollingDays}: what that layer says it can serve. */
  const extents = new Map();
  let instant = null; // ms since epoch, or null = live
  let timer = null;

  // A rolling declaration resolves against the clock on every read, so a layer whose pipeline refreshes
  // daily never has to re-declare. A concrete one is taken as given: if a layer's data ends 2026-09-10,
  // the bar's right edge is 2026-09-10 — LIVE is still how you leave the past, but the slider stops
  // where the frames stop instead of offering a fortnight of nothing.
  const resolve = (e) => {
    const nowHour = floorToHour(now());
    if (Number.isFinite(e?.rollingDays))
      return { start: nowHour - e.rollingDays * DAY_MS, end: nowHour };
    return { start: floorToHour(e?.startMs), end: floorToHour(e?.endMs) };
  };
  const domain = () => {
    let start = null;
    let end = null;
    for (const e of extents.values()) {
      const r = resolve(e);
      if (
        !Number.isFinite(r.start) ||
        !Number.isFinite(r.end) ||
        r.end < r.start
      )
        continue;
      start = start === null ? r.start : Math.min(start, r.start);
      end = end === null ? r.end : Math.max(end, r.end);
    }
    return start === null ? null : { start, end, stepMs: stepFor(end - start) };
  };
  const clamp = (ms) => {
    const d = domain();
    if (!d) return null;
    return Math.min(d.end, Math.max(d.start, floorToHour(ms)));
  };
  const notify = () => {
    const iso = store.get();
    for (const fn of listeners) {
      try {
        fn(iso);
      } catch (e) {
        console.warn("[observedTime] listener error:", e);
      }
    }
  };

  const store = {
    /** ISO hour string or null when live. */
    get() {
      return instant === null ? null : isoHour(instant);
    },
    getMs() {
      return instant;
    },
    isLive() {
      return instant === null;
    },
    /** `{start, end, stepMs}` spanning what the active layers can serve, or null when none can. */
    domain,
    /**
     * Declare what a layer can serve: `{startMs, endMs}`, `{rollingDays}`, or null to withdraw
     * (the bridge withdraws on disable). A selected instant is re-clamped into the new span, so the
     * layer that carried the bar out to a date cannot leave it parked there after it goes away.
     */
    setLayerExtent(id, extent) {
      const key = (v) => JSON.stringify(v ?? null);
      const before = key(extents.get(id));
      if (extent === null || extent === undefined) extents.delete(id);
      else extents.set(id, extent);
      if (key(extents.get(id)) === before) return false;
      if (instant !== null) instant = clamp(instant);
      notify();
      return true;
    },
    /** What each active layer declared, for the bar's coverage read and for tests. */
    extents() {
      return new Map(extents);
    },
    /** Select an instant (ISO string or ms). `null` returns to live. */
    set(value) {
      const next =
        value === null || value === undefined
          ? null
          : clamp(typeof value === "number" ? value : Date.parse(value));
      if (next !== null && !Number.isFinite(next)) return false;
      if (next === instant) return false;
      instant = next;
      if (next === null) store.pause();
      notify();
      return true;
    },
    step(n = 1) {
      const d = domain();
      if (!d) return false;
      const base = instant === null ? d.end : instant;
      return store.set(base + n * d.stepMs);
    },
    play(tickMs = 1000) {
      if (timer) return;
      const d = domain();
      if (!d) return;
      if (instant === null) store.set(d.start);
      timer = setI(() => {
        const cur = domain();
        if (!store.step(1) || !cur || instant >= cur.end) store.pause();
      }, tickMs);
      notify();
    },
    pause() {
      if (timer) {
        clearI(timer);
        timer = null;
        notify();
      }
    },
    isPlaying() {
      return timer !== null;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return store;
}

/**
 * Push the selected time to every enabled layer that can sample it, and to a
 * layer the moment it becomes enabled while a time is selected. Also keeps the
 * store's extents in step with what is enabled, so the bar spans the data that
 * is actually on. Returns an unsubscribe function. `dataManager` needs
 * `isEnabled(id)` and `subscribe(fn)`.
 */
export function attachObservedTime(store, dataManager, layers) {
  const samplers = layers.filter(
    (l) => l && typeof l.setObservedTime === "function",
  );
  // What each layer was last told. A layer switched off misses every push until it is back on, so
  // one last told a past instant must be told LIVE on re-enable or it draws that past under a LIVE bar.
  const told = new Map();
  const push = (layer, iso) => {
    told.set(layer.id, iso ?? null);
    return Promise.resolve(layer.setObservedTime(iso)).catch((e) =>
      console.warn(`[observedTime] ${layer.id}:`, e),
    );
  };
  // An extent may need a fetch (birds reads its archive manifest), so this is async and the store is
  // told when the answer lands. The store notifies on the change, which is what re-renders the bar —
  // that is how the slider grows to the archive's real span once the manifest arrives.
  const refreshExtent = async (layer) => {
    if (!dataManager.isEnabled(layer.id)) {
      store.setLayerExtent(layer.id, null);
      return;
    }
    let extent = null;
    try {
      extent = (await layer.getObservedExtent?.()) ?? null;
    } catch (e) {
      console.warn(`[observedTime] ${layer.id} extent:`, e);
    }
    store.setLayerExtent(layer.id, extent);
  };
  const unsubStore = store.subscribe((iso) => {
    for (const l of samplers) if (dataManager.isEnabled(l.id)) push(l, iso);
  });
  // "visibility", not "visibility-transition": the transition event is the manager's TRANSITIONAL
  // announcement and only ever carries lifecycleState 'enabling'/'disabling' — manager.js:696 is its one
  // call site — while the settle that writes 'enabled' notifies nobody. Settled visibility arrives as
  // {type:"visibility", enabled} (manager.js:954, and again right after _settleLifecycle at :1228).
  // Asking the transitional event for settled state meant this branch never ran in a browser: a layer
  // switched on while the bar was scrubbed back kept showing live data under a past timestamp.
  const unsubManager = dataManager.subscribe((change) => {
    if (change?.type !== "visibility") return;
    const l = samplers.find((x) => x.id === change.layerId);
    if (!l) return;
    refreshExtent(l);
    if (change.enabled === true && (!store.isLive() || (told.get(l.id) ?? null) !== null))
      push(l, store.get());
  });
  for (const l of samplers) refreshExtent(l);
  return () => {
    unsubStore();
    unsubManager();
    for (const l of samplers) store.setLayerExtent(l.id, null);
  };
}

/** Human label for the bar. */
export function describeObservedTime(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "LIVE";
}

/**
 * One floating bar for the whole app. Hidden until at least one sampling layer
 * is enabled AND has declared data to scrub over. `document` is optional so
 * tests can pass a stub.
 */
export function installObservedTimeUi(
  store,
  dataManager,
  layers,
  doc = globalThis.document,
) {
  if (!doc || doc.getElementById("observed-time")) return null;
  const ids = new Set(
    layers
      .filter((l) => l && typeof l.setObservedTime === "function")
      .map((l) => l.id),
  );
  const root = doc.createElement("div");
  root.id = "observed-time";
  root.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:30;" +
    "display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:8px;" +
    "background:rgba(8,12,18,0.82);color:#cfe3ff;font:12px/1.2 var(--font-mono, ui-monospace, monospace);" +
    "border:1px solid rgba(120,170,255,0.35);backdrop-filter:blur(4px)";
  root.innerHTML =
    '<span class="ot-title" style="min-width:9em;opacity:.8">🕒 observed time</span>' +
    '<button class="ot-play" title="Play / pause (1 hour per second)">▶</button>' +
    '<button class="ot-back" title="Back one hour">◀</button>' +
    '<input class="ot-range" type="range" min="0" max="0" value="0" style="width:38vw;max-width:520px">' +
    '<button class="ot-fwd" title="Forward one hour">▶|</button>' +
    '<button class="ot-live" title="Return to live data">LIVE</button>' +
    '<span class="ot-label" style="min-width:14em"></span>';
  for (const b of root.querySelectorAll("button")) {
    b.style.cssText =
      "background:#16233a;color:#cfe3ff;border:1px solid rgba(120,170,255,.4);border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit";
  }
  doc.body.appendChild(root);
  const range = root.querySelector(".ot-range"),
    label = root.querySelector(".ot-label"),
    play = root.querySelector(".ot-play");

  const syncDomain = () => {
    const d = store.domain();
    range.min = "0";
    range.max = String(d ? Math.round((d.end - d.start) / d.stepMs) : 0);
    const ms = store.getMs();
    range.value =
      !d || ms === null
        ? range.max
        : String(Math.round((ms - d.start) / d.stepMs));
  };
  const render = () => {
    syncDomain();
    label.textContent = describeObservedTime(store.get());
    play.textContent = store.isPlaying() ? "❚❚" : "▶";
    // A layer can be enabled and still have nothing to scrub over — its extent has not arrived, or it
    // declared none. A bar with no domain is a slider over an empty range, so it stays away.
    const show =
      !!store.domain() && [...ids].some((id) => dataManager.isEnabled(id));
    // `hidden` alone hides nothing here: this bar styles itself with an inline display:flex, and an
    // inline declaration outranks the UA stylesheet's [hidden]{display:none}. So display carries the
    // visibility and `hidden` stays in step for assistive tech.
    root.style.display = show ? "flex" : "none";
    root.hidden = !show;
  };
  range.addEventListener("input", () => {
    const d = store.domain();
    if (!d) return;
    store.set(d.start + Number(range.value) * d.stepMs);
  });
  root
    .querySelector(".ot-back")
    .addEventListener("click", () => store.step(-1));
  root.querySelector(".ot-fwd").addEventListener("click", () => store.step(1));
  root
    .querySelector(".ot-live")
    .addEventListener("click", () => store.set(null));
  play.addEventListener("click", () =>
    store.isPlaying() ? store.pause() : store.play(),
  );
  store.subscribe(render);
  // Both: "visibility-transition" keeps the bar responsive while a layer is still coming up, and
  // "visibility" is the settled announcement that arrives last and decides the final state. Listening
  // only to the transition left the bar reading the state a layer had DURING its enable, forever.
  dataManager.subscribe((change) => {
    if (
      change?.type === "visibility" ||
      change?.type === "visibility-transition"
    )
      render();
  });
  render();
  return root;
}
