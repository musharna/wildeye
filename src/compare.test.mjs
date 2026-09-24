import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { DataLayerManager } from './data/manager.js';
import { installDrapeExclusivity } from './data/drapeExclusive.js';
import {
  createCompare,
  SPLIT,
  encodeCompareParam,
  decodeCompareParam,
} from './compare.js';

const DRAPES = ['oisst', 'chlor-a', 'ndvi'];
function fakeLayer(id, { failEnable = false } = {}) {
  return {
    id,
    name: id,
    icon: '',
    source: 't',
    updateInterval: -1,
    async init() {},
    enable() {
      if (failEnable) throw new Error(`${id} refused`);
    },
    disable() {},
    async update() {
      return true;
    },
    getStats() {
      return { count: 0, lastUpdate: null };
    },
  };
}
function setup(opts = {}) {
  const mgr = new DataLayerManager({});
  for (const id of [...DRAPES, 'birds'])
    mgr.register(fakeLayer(id, { failEnable: opts.failing === id }));
  const splits = new Map();
  let position = null;
  const seen = [];
  const compare = createCompare({
    dataManager: mgr,
    drapeIds: DRAPES,
    setSplit: (id, dir) => {
      if (dir) splits.set(id, dir);
      else splits.delete(id);
    },
    setPosition: (p) => {
      position = p;
    },
  });
  installDrapeExclusivity(mgr, DRAPES, { exempt: compare.exempt });
  compare.subscribe((s) => seen.push(s));
  return { mgr, compare, splits, pos: () => position, seen };
}
const on = (mgr) => DRAPES.filter((id) => mgr.isEnabled(id));

test('SPLIT matches Cesium.SplitDirection', () => {
  assert.deepEqual(
    { ...SPLIT },
    {
      LEFT: Cesium.SplitDirection.LEFT,
      NONE: Cesium.SplitDirection.NONE,
      RIGHT: Cesium.SplitDirection.RIGHT,
    },
  );
});

test('set enables both sides, splits them left/right and places the divider', async () => {
  const { mgr, compare, splits, pos } = setup();
  await compare.set('oisst', 'chlor-a');
  assert.deepEqual(on(mgr), ['oisst', 'chlor-a']);
  assert.deepEqual(
    [...splits],
    [
      ['oisst', -1],
      ['chlor-a', 1],
    ],
  );
  assert.equal(pos(), 0.5);
  assert.deepEqual(compare.getState(), {
    left: 'oisst',
    right: 'chlor-a',
    position: 0.5,
  });
});

test('changing a side swaps that drape out and keeps compare on', async () => {
  const { mgr, compare, splits } = setup();
  await compare.set('oisst', 'chlor-a');
  await compare.set('ndvi', 'chlor-a');
  assert.deepEqual(on(mgr), ['chlor-a', 'ndvi']);
  assert.deepEqual(Object.fromEntries(splits), { ndvi: -1, 'chlor-a': 1 });
  assert.deepEqual(compare.getState(), {
    left: 'ndvi',
    right: 'chlor-a',
    position: 0.5,
  });
});

test('a third drape ends compare: both sides off, splits cleared, subscribers told null', async () => {
  const { mgr, compare, splits, seen } = setup();
  await compare.set('oisst', 'chlor-a');
  await mgr.setEnabled('ndvi', true, { origin: 'user' });
  assert.deepEqual(on(mgr), ['ndvi']);
  assert.equal(compare.getState(), null);
  assert.equal(splits.size, 0);
  assert.equal(seen.at(-1), null);
});

test('turning a side off by hand ends compare and leaves the other side whole', async () => {
  const { mgr, compare, splits } = setup();
  await compare.set('oisst', 'chlor-a');
  await mgr.setEnabled('oisst', false, { origin: 'user' });
  assert.equal(compare.getState(), null);
  assert.deepEqual(on(mgr), ['chlor-a']);
  assert.equal(splits.size, 0);
});

test('off keeps the left drape full-globe and turns the right off', async () => {
  const { mgr, compare, splits } = setup();
  await compare.set('oisst', 'chlor-a');
  await compare.off();
  assert.deepEqual(on(mgr), ['oisst']);
  assert.equal(splits.size, 0);
  assert.equal(compare.getState(), null);
  assert.equal(compare.exempt(), null);
});

test('move clamps to 0..1 and reaches the renderer', async () => {
  const { compare, pos } = setup();
  await compare.set('oisst', 'chlor-a');
  compare.move(0.25);
  assert.equal(pos(), 0.25);
  compare.move(-3);
  assert.equal(pos(), 0);
  compare.move(7);
  assert.equal(pos(), 1);
  assert.equal(compare.getState().position, 1);
});

test('a side that does not enable ends compare and rejects', async () => {
  const { mgr, compare, splits } = setup({ failing: 'chlor-a' });
  await assert.rejects(compare.set('oisst', 'chlor-a'), /chlor-a/);
  assert.equal(compare.getState(), null);
  assert.equal(splits.size, 0);
  assert.equal(mgr.isEnabled('chlor-a'), false);
  assert.equal(mgr.isEnabled('oisst'), true); // positive control: the side that worked stays, full-globe
});

test('set rejects a non-drape, the same drape twice, a bad position — and a valid set still works', async () => {
  const { compare } = setup();
  await assert.rejects(compare.set('birds', 'oisst'), /'birds' is not a drape/);
  await assert.rejects(compare.set('oisst', 'oisst'), /both sides are 'oisst'/);
  await assert.rejects(compare.set('oisst', 'ndvi', 1.5), /position 1.5/);
  assert.equal(compare.getState(), null);
  await compare.set('oisst', 'ndvi', 0.3);
  assert.deepEqual(compare.getState(), {
    left: 'oisst',
    right: 'ndvi',
    position: 0.3,
  });
});

test('cmp codec: registry tokens round-trip for every one of the 14 drapes; malformed values throw with the raw value', () => {
  const ALL = [
    'crw-bleaching',
    'oisst',
    'chlor-a',
    'crw-dhw',
    'crw-hotspot',
    'crw-seaice',
    'ndvi',
    'cmems-o2',
    'cmems-ph',
    'gibs-landcover',
    'gibs-evi',
    'gibs-lst',
    'gibs-nightlights',
    'gibs-biomass',
  ];
  assert.equal(
    encodeCompareParam({
      left: 'gibs-nightlights',
      right: 'gibs-landcover',
      position: 0.25,
    }),
    'bm.lc.25',
  );
  for (const left of ALL)
    for (const right of ALL)
      if (left !== right) {
        assert.deepEqual(
          decodeCompareParam(
            encodeCompareParam({ left, right, position: 0.5 }),
            ALL,
          ),
          { left, right, position: 0.5 },
        );
      }
  assert.equal(encodeCompareParam(null), null);
  assert.equal(decodeCompareParam(null, ALL), null);
  for (const bad of [
    'bm.lc',
    'bm.lc.101',
    'bm.bm.50',
    'zz.lc.50',
    'n.lc.50',
    'BM.lc.50',
    'bm.lc.5x',
  ]) {
    assert.throws(
      () => decodeCompareParam(bad, ALL),
      new RegExp(`cmp='${bad.replace(/\./g, '\\.')}'`),
      bad,
    );
  }
});

// Local qa-compare 2026-09-23: picking both sides while the default pair was still enabling left the
// stale pair's second side on alone and compare ended. A superseded set() went on to enable its own
// right side after a newer set() owned the state; that enable, outside the new pair, tripped the
// one-drape rule and turned both real sides off.
test('a newer set wins: a superseded set enables nothing further', async () => {
  const { mgr, compare } = setup();
  const first = compare.set('oisst', 'chlor-a'); // still enabling oisst when the user picks again
  await compare.set('ndvi', 'oisst');
  await first;
  assert.deepEqual(compare.getState(), { left: 'ndvi', right: 'oisst', position: 0.5 });
  assert.deepEqual(on(mgr), ['oisst', 'ndvi']);
});
