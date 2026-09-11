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
 * (Wave 0 item 5 of docs/superpowers/plans/2026-09-11-bio-sources-roadmap.md:
 * the birds replay was a layer-private frame-index widget.)
 */

const HOUR_MS = 3_600_000;

export function floorToHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}
export function isoHour(ms) {
  return new Date(floorToHour(ms))
    .toISOString()
    .replace(/:\d\d\.\d{3}Z$/, ":00Z");
}

/**
 * @param {{domainDays?: number, stepMs?: number, now?: () => number,
 *   setInterval?: Function, clearInterval?: Function}} [opts]
 */
export function createObservedTime(opts = {}) {
  const now = opts.now || (() => Date.now());
  const stepMs = opts.stepMs || HOUR_MS;
  const domainMs = (opts.domainDays ?? 30) * 86_400_000;
  const setI = opts.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearI = opts.clearInterval || ((h) => clearInterval(h));
  const listeners = new Set();
  let instant = null; // ms since epoch, or null = live
  let timer = null;

  const domain = () => {
    const end = floorToHour(now());
    return { start: end - domainMs, end, stepMs };
  };
  const clamp = (ms) => {
    const d = domain();
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
    domain,
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
    step(hours = 1) {
      const base = instant === null ? domain().end : instant;
      return store.set(base + hours * stepMs);
    },
    play(tickMs = 1000) {
      if (timer) return;
      if (instant === null) store.set(domain().start);
      timer = setI(() => {
        if (!store.step(1) || instant >= domain().end) store.pause();
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
 * layer the moment it becomes enabled while a time is selected. Returns an
 * unsubscribe function. `dataManager` needs `isEnabled(id)` and `subscribe(fn)`.
 */
export function attachObservedTime(store, dataManager, layers) {
  const samplers = layers.filter(
    (l) => l && typeof l.setObservedTime === "function",
  );
  const push = (layer, iso) =>
    Promise.resolve(layer.setObservedTime(iso)).catch((e) =>
      console.warn(`[observedTime] ${layer.id}:`, e),
    );
  const unsubStore = store.subscribe((iso) => {
    for (const l of samplers) if (dataManager.isEnabled(l.id)) push(l, iso);
  });
  const unsubManager = dataManager.subscribe((change) => {
    if (
      change?.type !== "visibility-transition" ||
      change.lifecycleState !== "enabled"
    )
      return;
    const l = samplers.find((x) => x.id === change.layerId);
    if (l && !store.isLive()) push(l, store.get());
  });
  return () => {
    unsubStore();
    unsubManager();
  };
}

/** Human label for the bar. */
export function describeObservedTime(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "LIVE";
}

/**
 * One floating bar for the whole app. Hidden until at least one sampling layer
 * is enabled. `document` is optional so tests can pass a stub.
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
    range.max = String(Math.round((d.end - d.start) / d.stepMs));
    const ms = store.getMs();
    range.value =
      ms === null ? range.max : String(Math.round((ms - d.start) / d.stepMs));
  };
  const render = () => {
    syncDomain();
    label.textContent = describeObservedTime(store.get());
    play.textContent = store.isPlaying() ? "❚❚" : "▶";
    root.hidden = ![...ids].some((id) => dataManager.isEnabled(id));
  };
  range.addEventListener("input", () => {
    const d = store.domain();
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
  dataManager.subscribe((change) => {
    if (change?.type === "visibility-transition") render();
  });
  render();
  return root;
}
