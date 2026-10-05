import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';
import { installDrapeExclusivity } from './drapeExclusive.js';
import { LAYER_STATE_REGISTRY, LAYER_STATE_STORAGE_KEY, LayerStateCoordinator, REGISTERED_LAYER_IDS,
  decodeLayerStateParams, encodeLayerStateParams } from './layerState.js';

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

test('the compare pair may both be on; a third drape turns both off; no pair means the old rule', async () => {
  const mgr = new DataLayerManager({});
  for (const id of ['oisst', 'chlor-a', 'ndvi', 'birds']) mgr.register(fakeLayer(id));
  let pair = ['oisst', 'chlor-a'];
  installDrapeExclusivity(mgr, ['oisst', 'chlor-a', 'ndvi'], { exempt: () => pair });
  await mgr.setEnabled('oisst', true, { origin: 'user' });
  await mgr.setEnabled('chlor-a', true, { origin: 'user' });
  assert.deepEqual(['oisst', 'chlor-a', 'ndvi'].map((id) => mgr.isEnabled(id)), [true, true, false]);
  await mgr.setEnabled('ndvi', true, { origin: 'user' });
  assert.deepEqual(['oisst', 'chlor-a', 'ndvi'].map((id) => mgr.isEnabled(id)), [false, false, true]);
  pair = null; // compare off: back to one at a time
  await mgr.setEnabled('oisst', true, { origin: 'user' });
  assert.deepEqual(['oisst', 'chlor-a', 'ndvi'].map((id) => mgr.isEnabled(id)), [true, false, false]);
});

// The drape the rule turns off must leave the share link and the saved state too.
const DRAPES = ['chlor-a', 'crw-dhw'];
const memoryStorage = () => {
  const values = new Map();
  return { writes: 0, getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem(k, v) { values.set(k, v); this.writes += 1; } };
};
const app = (storage) => {
  const mgr = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) mgr.register(fakeLayer(id));
  mgr.finalizeRegistrations(LAYER_STATE_REGISTRY);
  installDrapeExclusivity(mgr, DRAPES);
  const share = { provider: null, setLayerStateProvider(p) { this.provider = p; }, onLayerStateChange() {} };
  return { mgr, share, coordinator: new LayerStateCoordinator(mgr, share, { storage }) };
};
const shareHash = (share) => encodeLayerStateParams(new URLSearchParams([['v', '2']]), share.provider()).toString();

for (const origin of ['user', 'voice', 'tool']) {
  test(`a drape turned off by the one-drape rule leaves the share link and saved state (${origin})`, async () => {
    const storage = memoryStorage();
    const sender = app(storage);
    await sender.coordinator.start();
    await sender.mgr.setEnabled('birds', true, { origin });
    await sender.mgr.setEnabled('crw-dhw', true, { origin });
    await sender.mgr.setEnabled('chlor-a', true, { origin });
    assert.deepEqual(DRAPES.map((id) => sender.mgr.isEnabled(id)), [true, false]);
    assert.deepEqual(sender.coordinator.getDurableState().enabledLayerIds.sort(), ['birds', 'chlor-a']);
    assert.deepEqual(JSON.parse(storage.getItem(LAYER_STATE_STORAGE_KEY)).l.sort(), ['birds', 'chlor-a']);
    const hash = shareHash(sender.share);

    // The recipient sees the drape the sender saw, not the one that sorts last.
    const recipientStorage = memoryStorage();
    const recipient = app(recipientStorage);
    await recipient.coordinator.start({ shareLayerState: decodeLayerStateParams(new URLSearchParams(hash)) });
    assert.deepEqual(['birds', ...DRAPES].map((id) => recipient.mgr.isEnabled(id)), [true, true, false]);
    // Positive control: restoring a link is passive, it writes no saved state and keeps the link as sent.
    assert.equal(recipientStorage.writes, 0);
    assert.equal(shareHash(recipient.share), hash);
    sender.coordinator.destroy();
    recipient.coordinator.destroy();
  });
}

test('an old link naming two drapes restores passively: the rule fires but writes nothing', async () => {
  const storage = memoryStorage();
  const { mgr, share, coordinator } = app(storage);
  const hash = 'v=2&l=n.v.y'; // birds, chlor-a, crw-dhw: a link written before the fix
  await coordinator.start({ shareLayerState: decodeLayerStateParams(new URLSearchParams(hash)) });
  assert.deepEqual(['birds', ...DRAPES].map((id) => mgr.isEnabled(id)), [true, false, true]);
  assert.equal(storage.writes, 0);
  assert.equal(shareHash(share), hash);
  // Positive control: the next click is explicit and does write.
  await mgr.setEnabled('chlor-a', true, { origin: 'user' });
  assert.equal(storage.writes, 1);
  assert.equal(shareHash(share), 'v=2&l=n.v');
  coordinator.destroy();
});
