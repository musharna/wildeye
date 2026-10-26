import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_GROUPS, groupIndex, layerMatchesQuery, orderLayersForPanel } from './layerGroups.js';
import { REGISTERED_LAYER_IDS } from './layerState.js';

// species is driven by the Species panel and never shows a Layers row (src/data/species.js showInTogglePanel: false).
const NOT_IN_PANEL = new Set(['species']);

test('every panel layer the app registers is in exactly one group, and the map names no unknown layer', () => {
  const index = groupIndex(LAYER_GROUPS);
  const panelIds = REGISTERED_LAYER_IDS.filter((id) => !NOT_IN_PANEL.has(id));
  assert.equal(panelIds.length, 72);
  assert.deepEqual(panelIds.filter((id) => !index.has(id)), [], 'registered but ungrouped');
  assert.deepEqual([...index.keys()].filter((id) => !REGISTERED_LAYER_IDS.includes(id)), [], 'grouped but not registered');
  assert.equal(index.size, 72);
});

test('nine named groups, none empty and none a catch-all', () => {
  assert.deepEqual(LAYER_GROUPS.map((g) => g.label), ['Animal movement', 'Species records', 'Biodiversity patterns',
    'Habitats', 'Land conditions', 'Ocean conditions', 'Coral heat stress', 'Disease and vectors', 'Human impact']);
  for (const group of LAYER_GROUPS) assert.ok(group.layers.length > 0, group.id);
  assert.ok(!LAYER_GROUPS.some((g) => /other|misc/i.test(g.label)));
  // The user's own example (2026-10-20): malaria and ticks and mosquitoes belong together.
  const index = groupIndex(LAYER_GROUPS);
  assert.equal(index.get('malaria'), index.get('neon-vectors'));
  assert.equal(index.get('arbonet'), 'disease');
  assert.equal(index.get('gibs-disturbance'), 'land'); // beside fires and drought, its commonest causes
});

test('a layer filed in two groups is refused', () => {
  assert.throws(() => groupIndex([{ id: 'a', layers: ['x'] }, { id: 'b', layers: ['x'] }]), /x is in two Layers-panel groups \(a, b\)/);
  assert.equal(groupIndex([{ id: 'a', layers: ['x'] }, { id: 'b', layers: ['y'] }]).get('y'), 'b');
});

test('layers come out in group order, alphabetical by name inside a group; an ungrouped panel layer throws', () => {
  const groups = [{ id: 'g1', label: 'First', layers: ['b', 'a'] }, { id: 'g2', label: 'Second', layers: ['c', 'hidden'] }];
  const layers = [
    { id: 'c', name: 'Cod' },
    { id: 'b', name: 'beetles (model)' },
    { id: 'a', name: 'Ants 10' },
    { id: 'hidden', name: 'Hidden', showInTogglePanel: false },
  ];
  const ordered = orderLayersForPanel(layers, groups);
  assert.deepEqual(ordered.map((e) => [e.group.id, e.layers.map((l) => l.id)]), [['g1', ['a', 'b']], ['g2', ['c']]]);
  // A hidden layer needs no group; a shown one does.
  assert.doesNotThrow(() => orderLayersForPanel([{ id: 'loose', name: 'Loose', showInTogglePanel: false }], groups));
  assert.throws(() => orderLayersForPanel([...layers, { id: 'loose', name: 'Loose' }], groups), /Layer loose has no Layers-panel group/);
});

test('a group whose layers are not registered is left out', () => {
  const ordered = orderLayersForPanel([{ id: 'a', name: 'A' }], [{ id: 'g1', layers: ['a'] }, { id: 'g2', layers: ['z'] }]);
  assert.deepEqual(ordered.map((e) => e.group.id), ['g1']);
});

test('search matches every term against name and source, ignoring case', () => {
  const ticks = { name: 'Ticks and mosquitoes (NEON)', source: 'NEON' };
  const arbo = { name: 'Mosquito- and tick-borne disease cases (CDC ArboNET)', source: 'CDC ArboNET' };
  const water = { name: 'Wastewater virus trend', source: 'CDC NWSS' };
  assert.ok(layerMatchesQuery(ticks, 'TICK'));
  assert.ok(layerMatchesQuery(water, 'cdc'), 'source counts');
  assert.ok(layerMatchesQuery(arbo, 'tick cdc'));
  assert.ok(!layerMatchesQuery(ticks, 'tick cdc'), 'every term must match');
  assert.ok(!layerMatchesQuery(water, 'tick'));
  assert.ok(layerMatchesQuery(water, '   '), 'blank matches all');
});
