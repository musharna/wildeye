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
  let viewport = { width: 667, height: 375 };
  const regions = createShortViewportRegions({
    viewport: () => viewport,
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
  const api = { doc, panels, action, card, close, calls, setCard, open, regions };
  api.withViewport = (v) => { viewport = v; return api; };
  return api;
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

// Fix round 6 (critic r5 S1): on a short viewport the stack and the card start below the header boxes that sit over their columns (measured,
// not a constant): at 844x390 the title and its tagline run to about y 95, and a stack at 70 covered "NO PLACE LEFT".
test('each short-viewport column starts below the header boxes over it', async () => {
  const { topBelowHeader } = await import('./shortViewport.js');
  const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const header = [box(30, 20, 420, 66), box(24, 74, 300, 96), box(360, 28, 480, 72)]; // title, tagline, the top-centre buttons
  assert.equal(topBelowHeader({ boxes: header, left: 16, right: 476, viewportHeight: 390 }), 104, 'the stack column: below the tagline, 8 px gap');
  assert.equal(topBelowHeader({ boxes: header, left: 500, right: 828, viewportHeight: 390 }), 0, 'positive control: nothing above that column');
  assert.equal(topBelowHeader({ boxes: header, left: 268, right: 828, viewportHeight: 390 }), 104, 'the card column meets the tagline and the buttons');
  assert.equal(topBelowHeader({ boxes: [box(16, 300, 400, 330)], left: 16, right: 476, viewportHeight: 390 }), 0, 'a box in the lower half is not header');
  assert.equal(topBelowHeader({ boxes: [box(0, 0, 0, 0)], left: 16, right: 476, viewportHeight: 390 }), 0, 'an empty (hidden) box counts for nothing');
});

// Fix round 6 (critic r5 S2): the panel and the card take turns only when they would meet. Where the open panel leaves the globe's centre clear
// and the card still gets 320 px beside it, both stay, and the card's column starts 8 px right of the panel.
test('panel and card stay side by side where they fit and the centre is clear, and take turns where they do not', () => {
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const make = (viewport) => {
    const w = world();
    w.panels[2].getBoundingClientRect = () => rect(16, 97, 476, 440);
    w.card.style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
    return w.withViewport(viewport);
  };
  const wide = make({ width: 1280, height: 600 });
  wide.open('species-panel');
  wide.calls.length = 0;
  wide.setCard(true);
  assert.deepEqual(wide.calls, [], '1280x600: SPECIES stays open');
  assert.equal(wide.card.style.props['--short-card-left'], '484px', 'the card starts right of the panel');
  wide.setCard(false);
  assert.equal(wide.card.style.props['--short-card-left'], undefined, 'and goes back to its column when it closes');
  const narrow = make({ width: 932, height: 430 }); // the panel (16-476) covers the centre (466, 215)
  narrow.open('species-panel');
  narrow.calls.length = 0;
  narrow.setCard(true);
  assert.deepEqual(narrow.calls, [['species-panel', true]], '932x430: the panel folds (it covers the pick target)');
  const small = make({ width: 1100, height: 1000 }); // centre (550, 500) clear, 1100-16-484 = 600 px for the card: fits
  small.open('species-panel');
  small.calls.length = 0;
  small.setCard(true);
  assert.deepEqual(small.calls, []);
  const cramped = make({ width: 800, height: 900 }); // centre (400, 450) is below the panel, but only 300 px would be left for the card
  cramped.open('species-panel');
  cramped.calls.length = 0;
  cramped.setCard(true);
  assert.deepEqual(cramped.calls, [['species-panel', true]], 'too little room beside: the panel folds');
  // Opening a panel while the card shows: kept beside when it fits, the card closed when not.
  const reopen = make({ width: 1280, height: 600 });
  reopen.setCard(true);
  reopen.open('species-panel');
  assert.equal(reopen.card.hidden, false, 'the card stays');
  assert.equal(reopen.card.style.props['--short-card-left'], '484px');
  const reopenNarrow = make({ width: 932, height: 430 });
  reopenNarrow.setCard(true);
  reopenNarrow.open('species-panel');
  assert.equal(reopenNarrow.card.hidden, true, 'the card closes where they would meet');
});
