import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './data/manager.js';
import { installDrapeExclusivity } from './data/drapeExclusive.js';
import { createCompare } from './compare.js';
import { installCompareUi } from './compareUi.js';

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
      return c;
    },
    addEventListener(ev, fn) {
      this.handlers[ev] = fn;
    },
    setPointerCapture() {},
  });
  return { body: mk('body'), createElement: mk };
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
function setup() {
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
        return { count: 1, lastUpdate: null, time: time[id], error: error[id] };
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
  const doc = stubDoc();
  const container = {
    ...doc.createElement('div'),
    getBoundingClientRect: () => ({ left: 100, width: 800 }),
  };
  let restack = null;
  const ui = installCompareUi({
    doc,
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
  const { compare, ui } = setup();
  await compare.set('oisst', 'chlor-a');
  ui.divider.handlers.pointermove({ clientX: 300 }); // not dragging yet: ignored
  assert.equal(compare.getState().position, 0.5);
  ui.divider.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  ui.divider.handlers.pointermove({ clientX: 300 }); // (300-100)/800
  assert.equal(compare.getState().position, 0.25);
  assert.equal(ui.divider.style.left, '25%');
  ui.divider.handlers.pointermove({ clientX: 5000 });
  assert.equal(compare.getState().position, 1);
  ui.divider.handlers.pointerup({});
  ui.divider.handlers.pointermove({ clientX: 300 });
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
