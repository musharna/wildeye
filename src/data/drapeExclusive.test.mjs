import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';
import { installDrapeExclusivity } from './drapeExclusive.js';

function fakeLayer(id) {
  return { id, name: id, icon: '', source: 't', updateInterval: -1,
    async init() {}, enable() {}, disable() {}, async update() { return true; },
    getStats() { return { count: 0, lastUpdate: null }; } };
}
const setup = (install) => {
  const mgr = new DataLayerManager({});
  for (const id of ['oisst', 'chlor-a', 'ndvi', 'birds']) mgr.register(fakeLayer(id));
  if (install) installDrapeExclusivity(mgr, ['oisst', 'chlor-a', 'ndvi']);
  return mgr;
};

test('positive control: without the picker, drapes stack', async () => {
  const mgr = setup(false);
  await mgr.setEnabled('oisst', true, { origin: 'user' });
  await mgr.setEnabled('chlor-a', true, { origin: 'user' });
  assert.deepEqual(['oisst', 'chlor-a'].map((id) => mgr.isEnabled(id)), [true, true]);
});

test('enabling a drape disables the other enabled drapes; non-drapes untouched', async () => {
  const mgr = setup(true);
  await mgr.setEnabled('birds', true, { origin: 'user' });
  await mgr.setEnabled('oisst', true, { origin: 'user' });
  await mgr.setEnabled('chlor-a', true, { origin: 'user' });
  await mgr.setEnabled('ndvi', true, { origin: 'programmatic' }); // restore path uses the same intent lane
  assert.deepEqual(['oisst', 'chlor-a', 'ndvi', 'birds'].map((id) => mgr.isEnabled(id)), [false, false, true, true]);
  // turning one off does not cascade
  await mgr.setEnabled('ndvi', false, { origin: 'user' });
  assert.deepEqual(['oisst', 'chlor-a', 'ndvi', 'birds'].map((id) => mgr.isEnabled(id)), [false, false, false, true]);
});

test('rejects a manager without the request hook', () => {
  assert.throws(() => installDrapeExclusivity({}, ['a']), /subscribeVisibilityRequests/);
});
