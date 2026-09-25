import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './data/manager.js';
import { installDrapeExclusivity } from './data/drapeExclusive.js';
import { createCompare } from './compare.js';
import { installCompareUi } from './compareUi.js';
import { createObservedTime, attachObservedTime } from './observedTime.js';

// A DOM stub: `style` is a plain object, so a test reads back exactly what the code assigned.
function stubDoc() {
  const mk = (tag) => ({
    tag,
    children: [],
    style: {},
    handlers: {},
    textContent: '',
    value: '',
    className: '',
    id: '',
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      this.children.splice(this.children.indexOf(c), 1);
      c.parentNode = null;
      return c;
    },
    addEventListener(ev, fn) {
      this.handlers[ev] = fn;
    },
    removeEventListener(ev, fn) {
      if (this.handlers[ev] === fn) delete this.handlers[ev];
    },
    setPointerCapture() {},
  });
  const doc = mk('document');
  return { body: mk('body'), createElement: mk, addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener, handlers: doc.handlers };
}
const find = (root, pred) => {
  if (pred(root)) return root;
  for (const c of root.children) {
    const f = find(c, pred);
    if (f) return f;
  }
  return null;
};
const byClass = (root, cls) => find(root, (e) => e.className === cls);

const DRAPES = [
  { id: 'oisst', name: 'Sea surface temp' },
  { id: 'chlor-a', name: 'Chlorophyll' },
  { id: 'ndvi', name: 'NDVI' },
];
const time = {
  oisst: '2026-09-20T00:00:00Z',
  'chlor-a': '2026-09-18',
  ndvi: null,
};
const error = { oisst: null, 'chlor-a': null, ndvi: null };
const loading = { oisst: null, 'chlor-a': null, ndvi: null };
function setup(extra = {}) {
  const mgr = new DataLayerManager({});
  for (const { id } of DRAPES)
    mgr.register({
      id,
      name: id,
      icon: '',
      source: 't',
      updateInterval: -1,
      async init() {},
      enable() {},
      disable() {},
      async update() {
        return true;
      },
      getStats() {
        return { count: 1, lastUpdate: null, time: time[id], error: error[id], loadingTime: loading[id] };
      },
    });
  const ids = DRAPES.map((d) => d.id);
  const compare = createCompare({
    dataManager: mgr,
    drapeIds: ids,
    setSplit() {},
    setPosition() {},
  });
  installDrapeExclusivity(mgr, ids, { exempt: compare.exempt });
  const doc = { ...stubDoc(), ...extra.doc };
  const container = {
    ...doc.createElement('div'),
    getBoundingClientRect: () => ({ left: 100, width: 800 }),
  };
  let restack = null;
  const ui = installCompareUi({
    doc,
    observedTime: extra.observedTime,
    compare,
    dataManager: mgr,
    drapes: DRAPES,
    container,
    onRestack: (fn) => {
      restack = fn;
      return () => {};
    },
  });
  return { mgr, compare, doc, container, ui, fireRestack: () => restack() };
}
// the manager's enable lifecycle spans several awaits; one macrotask of slack settles it
const tick = () => new Promise((r) => setTimeout(r, 20));

test('the pill opens compare with the drape already on as the left side; panel and divider appear', async () => {
  const { mgr, compare, ui } = setup();
  assert.equal(ui.panel.style.display, 'none');
  assert.equal(ui.divider.style.display, 'none');
  await mgr.setEnabled('chlor-a', true, { origin: 'user' });
  ui.toggle.handlers.click();
  await tick();
  assert.deepEqual(compare.getState(), {
    left: 'chlor-a',
    right: 'oisst',
    position: 0.5,
  });
  assert.equal(ui.panel.style.display, 'flex');
  assert.equal(ui.divider.style.display, 'block');
  assert.equal(ui.divider.style.left, '50%');
  assert.equal(ui.toggle.style.display, 'none');
});

test('each side is labelled with its own date; a side with no date or in error says so', async () => {
  const { compare, ui } = setup();
  await compare.set('oisst', 'chlor-a');
  assert.equal(byClass(ui.panel, 'cmp-left-date').textContent, '2026-09-20');
  assert.equal(byClass(ui.panel, 'cmp-right-date').textContent, '2026-09-18');
  await compare.set('oisst', 'ndvi');
  assert.equal(byClass(ui.panel, 'cmp-right-date').textContent, 'no date');
  error.ndvi = 'map tiles failing';
  ui.render();
  assert.equal(
    byClass(ui.panel, 'cmp-right-date').textContent,
    '⚠ map tiles failing',
  );
  error.ndvi = null;
});

test("side labels follow a restack (a scrub rebuilt a drape's image)", async () => {
  const { compare, ui, fireRestack } = setup();
  await compare.set('oisst', 'chlor-a');
  time['chlor-a'] = '2019-06-01';
  fireRestack();
  assert.equal(byClass(ui.panel, 'cmp-right-date').textContent, '2019-06-01');
  time['chlor-a'] = '2026-09-18';
});

test("choosing a side in a select sets it; choosing the other side's drape swaps them", async () => {
  const { compare, ui } = setup();
  await compare.set('oisst', 'chlor-a');
  const right = byClass(ui.panel, 'cmp-right');
  right.value = 'ndvi';
  right.handlers.change();
  await tick();
  assert.deepEqual(compare.getState(), {
    left: 'oisst',
    right: 'ndvi',
    position: 0.5,
  });
  const left = byClass(ui.panel, 'cmp-left');
  left.value = 'ndvi';
  left.handlers.change();
  await tick();
  assert.deepEqual(compare.getState(), {
    left: 'ndvi',
    right: 'oisst',
    position: 0.5,
  });
});

test('dragging the divider moves the split; drag past the edge clamps', async () => {
  const { compare, ui, doc } = setup();
  await compare.set('oisst', 'chlor-a');
  assert.equal(doc.handlers.pointermove, undefined); // not dragging yet: nothing listens
  ui.divider.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  doc.handlers.pointermove({ clientX: 300 }); // (300-100)/800
  assert.equal(compare.getState().position, 0.25);
  assert.equal(ui.divider.style.left, '25%');
  doc.handlers.pointermove({ clientX: 5000 });
  assert.equal(compare.getState().position, 1);
  doc.handlers.pointerup({});
  assert.equal(doc.handlers.pointermove, undefined);
  assert.equal(compare.getState().position, 1);
  assert.match(ui.divider.style.cssText, /touch-action:none/);
});

test('close ends compare and hides the panel; compare ended elsewhere hides it too', async () => {
  const { mgr, compare, ui } = setup();
  await compare.set('oisst', 'chlor-a');
  byClass(ui.panel, 'cmp-close').handlers.click();
  await tick();
  assert.equal(compare.getState(), null);
  assert.equal(ui.panel.style.display, 'none');
  assert.equal(ui.divider.style.display, 'none');
  assert.equal(ui.toggle.style.display, '');
  await compare.set('oisst', 'chlor-a');
  await mgr.setEnabled('ndvi', true, { origin: 'user' });
  assert.equal(ui.panel.style.display, 'none');
});

// Placement above the command dock moved to bottomStack.js (one stack for time bar + compare).

// Final review I1: a scrub reaches a side through setObservedTime, not the manager, and a scrub into a
// gap hides the imagery without a restack, so nothing re-rendered the panel — the side kept its old date
// over an empty half of the globe, and a warning, once shown, stuck after scrubbing back out.
test('a scrub that puts a side into a gap relabels it without a restack; scrubbing back out clears it', async () => {
  const store = createObservedTime();
  const { mgr, compare, ui } = setup({ observedTime: store });
  const ndvi = mgr.layers.get('ndvi').module;
  ndvi.setObservedTime = (iso) => {
    error.ndvi = iso && iso < '2020' ? `no ndvi data at or before ${iso.slice(0, 10)}` : null;
  };
  attachObservedTime(store, mgr, [ndvi]); // after the UI: the bridge's listener runs second
  await compare.set('oisst', 'ndvi');
  const label = () => byClass(ui.panel, 'cmp-right-date').textContent;
  assert.equal(label(), 'no date');
  store.setLayerExtent('probe', { startMs: Date.parse('2010-01-01T00:00:00Z'), endMs: Date.parse('2026-01-01T00:00:00Z') });
  store.set('2015-06-01T00:00:00Z');
  await tick();
  assert.equal(label(), '⚠ no ndvi data at or before 2015-06-01');
  store.set(null);
  await tick();
  assert.equal(label(), 'no date');
  error.ndvi = null;
});

test('a side label says when its next frame is still loading, not only the frame it had', async () => {
  // A raster drape keeps drawing its old frame while the new one downloads; the label showed the old
  // date with nothing to say a change was on its way (review minor, stage 2).
  const { compare, doc } = setup();
  loading.oisst = '2026-09-10T00:00:00Z';
  try {
    await compare.set('oisst', 'chlor-a');
    await tick();
    assert.equal(byClass(doc.body, 'cmp-left-date').textContent, '2026-09-20 → loading 2026-09-10');
    assert.equal(byClass(doc.body, 'cmp-right-date').textContent, '2026-09-18');
  } finally {
    loading.oisst = null;
  }
});

test('destroy() takes the pill, panel and divider off the page and stops listening', async () => {
  const { mgr, compare, doc, container, ui } = setup();
  const before = mgr._listeners.size;
  ui.destroy();
  assert.equal(find(doc.body, (e) => e.id === 'compare-toggle'), null);
  assert.equal(find(doc.body, (e) => e.id === 'compare-panel'), null);
  assert.equal(find(container, (e) => e.id === 'compare-divider'), null);
  assert.equal(mgr._listeners.size, before - 1);
  const shown = ui.toggle.style.display;
  await compare.set('oisst', 'chlor-a');
  await tick();
  assert.equal(ui.toggle.style.display, shown); // no longer rendered
});

test('dragging the divider follows the pointer even where pointer capture is unavailable', async () => {
  // setPointerCapture throws for a pointer the browser does not consider active, and without capture
  // the 4 px divider only saw moves while the pointer stayed on it.
  const { compare, doc, ui } = setup();
  await compare.set('oisst', 'chlor-a');
  ui.divider.setPointerCapture = () => {
    throw new Error('InvalidPointerId');
  };
  ui.divider.handlers.pointerdown({ pointerId: 7, preventDefault() {} });
  doc.handlers.pointermove({ clientX: 500 }); // off the divider: the document still hears it
  assert.equal(compare.getState().position, 0.5);
  doc.handlers.pointerup?.({});
  assert.equal(doc.handlers.pointermove, undefined); // the drag let go of the document
  assert.equal(compare.getState().position, 0.5);
});
