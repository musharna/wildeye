// src/bio/whatLivesHere.test.mjs — arm-then-click: marker clicks stay normal, sky keeps it armed,
// a ground click sends exactly one GBIF search and lists the species.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { classifyClick, createWhatLivesHere, HEADING } from './whatLivesHere.js';

const YELLOWSTONE = Cesium.Cartesian3.fromDegrees(-110.83, 44.46);
const CLICK = { position: { x: 1, y: 1 } };

function rig({ picked = undefined, ground = YELLOWSTONE, near = { total: 5, species: [{ key: 5232437, count: 5 }] }, nearError = null } = {}) {
  const calls = { near: [], names: [], status: [], list: [], picked: [], armed: [] };
  const viewer = {
    scene: { canvas: { style: {} }, pick: () => picked, pickPositionSupported: false, pickPosition: () => undefined, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    camera: { pickEllipsoid: () => ground },
  };
  const client = {
    speciesNear: async (args) => { calls.near.push(args); if (nearError) throw nearError; return near; },
    speciesName: async (key) => { calls.names.push(key); return { key, scientificName: 'Branta canadensis', commonName: 'Canada Goose' }; },
  };
  const card = { showStatus: (s) => calls.status.push(s), showList: (l) => calls.list.push(l) };
  const controller = createWhatLivesHere({
    viewer,
    client,
    card,
    getParams: () => ({ years: 'recent', radiusKm: 10 }),
    onPickSpecies: (p) => calls.picked.push(p),
    onArmedChange: (on) => calls.armed.push(on),
    handlerFor: () => ({ setInputAction() {}, destroy() {} }),
    doc: { addEventListener() {} },
  });
  return { controller, calls, viewer };
}

test('classifyClick: marker, sky, ground', () => {
  assert.equal(classifyClick({ picked: { id: 'occ:1' }, position: YELLOWSTONE }), 'entity');
  assert.equal(classifyClick({ picked: { primitive: {} }, position: YELLOWSTONE }), 'ground', 'a pick without an id (terrain, 3D tiles) is ground');
  assert.equal(classifyClick({ picked: undefined, position: null }), 'sky');
  assert.equal(classifyClick({ picked: undefined, position: YELLOWSTONE }), 'ground');
});

test('unarmed clicks do nothing; a marker click sends no query and stays armed', () => {
  const { controller, calls } = rig({ picked: { id: 'occ:blue-whale:2026-09-01:0' } });
  assert.equal(controller.handleClick(CLICK), null);
  controller.arm();
  assert.equal(controller.handleClick(CLICK), null);
  assert.equal(calls.near.length, 0);
  assert.equal(controller.armed, true);
});

test('a ground click sends exactly one GBIF search at the clicked point and lists the names', async () => {
  const { controller, calls, viewer } = rig();
  controller.arm();
  assert.equal(viewer.scene.canvas.style.cursor, 'crosshair');
  assert.deepEqual(calls.armed, [true]);
  await controller.handleClick(CLICK);
  assert.equal(calls.near.length, 1);
  assert.equal(calls.near[0].radiusKm, 10);
  assert.equal(calls.near[0].years, 'recent');
  assert.ok(Math.abs(calls.near[0].lat - 44.46) < 1e-6 && Math.abs(calls.near[0].lon + 110.83) < 1e-6);
  assert.equal(controller.armed, false);
  assert.equal(viewer.scene.canvas.style.cursor, '');
  assert.equal(calls.list.length, 1);
  const list = calls.list[0];
  assert.equal(list.heading, HEADING);
  assert.match(list.filterLine, /^CC0 and CC BY records · \d{4}–\d{4} · within 10 km · 5 records$/);
  assert.match(list.footerHref, /^https:\/\/www\.gbif\.org\/occurrence\/search\?/);
  assert.equal(list.footer, 'Occurrence data: GBIF.org, CC0 and CC BY records only');
  assert.deepEqual(list.entries, [{ key: 5232437, count: 5, scientificName: 'Branta canadensis', commonName: 'Canada Goose', error: undefined }]);
  list.onRow({ key: 5232437, primary: 'Canada Goose' });
  assert.deepEqual(calls.picked, [{ taxonKey: 5232437, name: 'Canada Goose' }]);
  assert.equal(controller.handleClick(CLICK), null, 'one query per arming');
  assert.equal(calls.near.length, 1);
});

test('sky keeps it armed; zero records and failures are different messages', async () => {
  const sky = rig({ ground: null });
  sky.controller.arm();
  assert.equal(sky.controller.handleClick(CLICK), null);
  assert.equal(sky.controller.armed, true);
  assert.match(sky.calls.status.at(-1).message, /Click on the globe/);

  const empty = rig({ near: { total: 0, species: [] } });
  empty.controller.arm();
  await empty.controller.handleClick(CLICK);
  assert.match(empty.calls.status.at(-1).message, /^No CC0\/CC BY records within 10 km for \d{4}–\d{4}\. Try a larger radius or all years\.$/);
  assert.equal(empty.calls.list.length, 0);

  const down = rig({ nearError: new Error('HTTP 503') });
  down.controller.arm();
  const originalError = console.error;
  console.error = () => {};
  try {
    await down.controller.handleClick(CLICK);
  } finally {
    console.error = originalError;
  }
  const failure = down.calls.status.at(-1);
  assert.equal(failure.message, 'GBIF search failed (HTTP 503)');
  assert.equal(typeof failure.retry, 'function');
});
