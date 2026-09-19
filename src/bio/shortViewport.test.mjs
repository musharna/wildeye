// src/bio/shortViewport.test.mjs — fix round 4 (critic r3 S1', S3, N2): on a short viewport the left stack's open panel and the details card
// never show together, and keyboard focus follows the parts that hide and return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORT_VIEWPORT_QUERY, createShortViewportRegions } from './shortViewport.js';

// A tiny DOM: elements with hidden, classList, contains and focus; a document with activeElement and body.
function world({ short = true } = {}) {
  const doc = { body: { id: 'BODY', isConnected: true }, activeElement: null };
  doc.activeElement = doc.body;
  const el = (id, parent = null) => {
    const node = { id, parent, hidden: false, isConnected: true, classes: new Set(), children: [] };
    node.classList = { contains: (c) => node.classes.has(c) };
    node.contains = (other) => { for (let n = other; n; n = n.parent) if (n === node) return true; return false; };
    node.focus = () => { doc.activeElement = node; };
    node.querySelector = (sel) => node.children.find((c) => sel.includes(c.id)) ?? null;
    if (parent) parent.children.push(node);
    return node;
  };
  const stack = el('left-panel-stack');
  const panels = ['data-panel', 'scene-panel', 'species-panel'].map((id) => { const p = el(id, stack); p.classes.add('collapsed'); p.dataset = { panelId: id }; return p; });
  stack.querySelectorAll = () => panels;
  const action = el('species-what-lives-here', panels[2]);
  const card = el('bio-card');
  card.hidden = true;
  const close = el('bio-card-close', card);
  close.className = 'bio-card-close';
  let observer = null;
  const calls = [];
  const setPanelCollapsed = (id, collapsed) => {
    calls.push([id, collapsed]);
    const p = panels.find((x) => x.id === id);
    const was = p.classes.has('collapsed');
    if (collapsed) p.classes.add('collapsed'); else p.classes.delete('collapsed');
    if (collapsed && p.contains(doc.activeElement)) doc.activeElement = doc.body; // a hidden element loses focus
    observer?.([{ target: p, attributeName: 'class', oldValue: was ? 'collapsed' : '' }]);
  };
  const regions = createShortViewportRegions({
    isShort: () => short,
    stack,
    cardElement: card,
    dismissCard: () => { calls.push(['dismiss']); setCard(false); },
    setPanelCollapsed,
    doc,
    observe: (fn) => { observer = fn; },
  });
  function setCard(visible) {
    card.hidden = !visible;
    if (!visible && card.contains(doc.activeElement)) doc.activeElement = doc.body;
    observer?.([{ target: card, attributeName: 'hidden' }]);
  }
  const open = (id) => setPanelCollapsed(id, false);
  return { doc, panels, action, card, close, calls, setCard, open, regions };
}

test('the short-viewport condition is one query', () => {
  assert.equal(SHORT_VIEWPORT_QUERY, '(max-height: 600px) and (orientation: landscape)');
});

test('short viewport: the card folds the open panel, moves focus that was in it to the card, and gives both back when it closes', () => {
  const w = world();
  w.open('species-panel');
  w.action.focus(); // WHAT LIVES HERE, armed with Enter
  w.calls.length = 0;
  w.setCard(true); // the "Click a spot" card
  assert.deepEqual(w.calls, [['species-panel', true]]);
  assert.equal(w.doc.activeElement, w.close, 'focus goes to the card\'s close button, not BODY');
  w.setCard(false); // Escape or the ×: cancelled
  assert.deepEqual(w.calls, [['species-panel', true], ['species-panel', false]]);
  assert.equal(w.doc.activeElement, w.action, 'focus back on WHAT LIVES HERE');
});

test('short viewport: opening a panel while the card shows closes the card (one tap on a pill after a pick)', () => {
  const w = world();
  w.open('species-panel');
  w.setCard(true);
  w.calls.length = 0;
  w.open('species-panel'); // the SPECIES + tapped while the results show
  assert.deepEqual(w.calls, [['species-panel', false], ['dismiss']]);
  assert.equal(w.panels[2].classes.has('collapsed'), false, 'SPECIES stays open');
  assert.equal(w.card.hidden, true);
});

test('short viewport: a card shown with every panel collapsed changes nothing, and closing it reopens nothing', () => {
  const w = world();
  w.setCard(true);
  w.setCard(false);
  assert.deepEqual(w.calls, []);
});

test('tall viewport: nothing moves (positive control), and focus stays where it was', () => {
  const w = world({ short: false });
  w.open('species-panel');
  w.action.focus();
  w.calls.length = 0;
  w.setCard(true);
  w.open('data-panel');
  w.setCard(false);
  assert.deepEqual(w.calls, [['data-panel', false]], 'only the explicit open');
  assert.equal(w.doc.activeElement, w.action);
});
