// src/bio/pickClearance.test.mjs — fix round 3 (critic r2 S1): the open left-stack panel that covers the globe's centre steps aside while
// WHAT LIVES HERE waits for a click, and comes back only if the pick is cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPickClearance } from './pickClearance.js';

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
function rig({ panelRect, canvasRect = rect(0, 0, 667, 375) }) {
  const panels = [
    { id: 'data-panel', collapsed: true, getBoundingClientRect: () => rect(0, 0, 0, 0) },
    { id: 'species-panel', collapsed: false, getBoundingClientRect: () => panelRect },
  ];
  for (const p of panels) p.classList = { contains: (name) => name === 'collapsed' && p.collapsed };
  const calls = [];
  const clearance = createPickClearance({
    stack: { querySelectorAll: () => panels },
    canvas: { getBoundingClientRect: () => canvasRect },
    setPanelCollapsed: (id, collapsed) => { calls.push([id, collapsed]); panels.find((p) => p.id === id).collapsed = collapsed; },
  });
  return { clearance, calls, panels };
}

test('an open panel over the globe centre collapses when the pick is armed and returns when it is cancelled', () => {
  const { clearance, calls } = rig({ panelRect: rect(16, 70, 460, 178) }); // 667x375: the centre (333.5, 187.5) is under the panel
  clearance.onArmedChange(true, 'arm');
  assert.deepEqual(calls, [['species-panel', true]]);
  clearance.onArmedChange(false, 'cancel');
  assert.deepEqual(calls, [['species-panel', true], ['species-panel', false]], 'a cancelled pick puts the panel back');
});

test('after a pick the panel stays collapsed, so the results card is not covered; the SPECIES pill is one tap away', () => {
  const { clearance, calls } = rig({ panelRect: rect(16, 70, 460, 178) });
  clearance.onArmedChange(true, 'arm');
  clearance.onArmedChange(false, 'pick');
  assert.deepEqual(calls, [['species-panel', true]]);
  clearance.onArmedChange(true, 'arm');
  clearance.onArmedChange(false, 'cancel');
  assert.deepEqual(calls, [['species-panel', true]], 'nothing to put back: the panel was already collapsed when armed again');
});

test('a panel clear of the centre stays open (portrait phone, desktop)', () => {
  const { clearance, calls } = rig({ panelRect: rect(16, 70, 343, 256), canvasRect: rect(0, 0, 375, 667) }); // 375x667: centre y 333.5
  clearance.onArmedChange(true, 'arm');
  clearance.onArmedChange(false, 'cancel');
  assert.deepEqual(calls, [], 'positive control: nothing moves when the centre is clear');
});

test('a panel the person reopened during the pick is left alone on cancel', () => {
  const { clearance, calls, panels } = rig({ panelRect: rect(16, 70, 460, 178) });
  clearance.onArmedChange(true, 'arm');
  panels[1].collapsed = false; // reopened by hand while armed
  clearance.onArmedChange(false, 'cancel');
  assert.deepEqual(calls, [['species-panel', true]]);
});
