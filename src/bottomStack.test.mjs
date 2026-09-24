import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackAboveChrome } from './bottomStack.js';

// The time bar sat at a constant bottom:28px under the command dock (bottom:2vh, ~62px tall), so at
// every viewport a click on the slider's middle hit the dock (live qa-observed-time slider-clickable,
// 2026-09-23). Bottom-centre is one stack above the bottom chrome: dock + credits → time bar → compare.

const el = (top, height, extra = {}) => ({
  style: {},
  children: [],
  querySelectorAll: () => [],
  getBoundingClientRect: () => ({ top, height }),
  ...extra,
});

const env = (innerHeight = 900) => {
  const ros = [];
  const mos = [];
  let resize = null;
  const win = {
    innerHeight,
    addEventListener: (ev, fn) => { if (ev === 'resize') resize = fn; },
    removeEventListener: (ev, fn) => { if (ev === 'resize' && resize === fn) resize = null; },
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; this.seen = []; this.off = false; ros.push(this); }
      observe(t) { this.seen.push(t); }
      disconnect() { this.off = true; }
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.seen = []; this.off = false; mos.push(this); }
      observe(t, opts) { this.seen.push([t, opts]); }
      disconnect() { this.off = true; }
    },
  };
  return { doc: { defaultView: win }, ros, mos, resize: () => resize?.(), hasResize: () => !!resize };
};

test('the time bar sits above the dock\'s highest edge (a child pokes out), and compare above the time bar', () => {
  const { doc } = env();
  const dock = el(820, 62, { children: [el(804, 86)] }); // the voice widget reaches above the dock's box
  const bar = el(0, 43);
  const toggle = el(0, 26);
  stackAboveChrome({ doc, below: () => [dock], items: () => [bar, toggle] });
  assert.equal(bar.style.bottom, '104px'); // 900 - 804 + 8
  assert.equal(toggle.style.bottom, '155px'); // 104 + 43 + 8
});

test('an open pinned tray raises the stack: the anchor\'s trays count as part of it', () => {
  const { doc } = env();
  const tray = el(600, 200);
  const dock = el(820, 62, { querySelectorAll: (sel) => (sel.includes('dock-popover-content') ? [tray] : []) });
  const bar = el(0, 43);
  stackAboveChrome({ doc, below: () => [dock], items: () => [bar] });
  assert.equal(bar.style.bottom, '308px'); // 900 - 600 + 8
});

test('a hidden item keeps a place but gives up its height; one slot can hold alternates (pill | panel)', () => {
  const { doc } = env();
  const dock = el(820, 62);
  const bar = el(0, 0); // time bar hidden: no layer to scrub
  const toggle = el(0, 0); // pill hidden while the panel shows
  const panel = el(0, 30);
  const above = el(0, 10);
  stackAboveChrome({ doc, below: () => [dock], items: () => [bar, [toggle, panel], above] });
  assert.equal(bar.style.bottom, '88px'); // 900 - 820 + 8
  assert.equal(toggle.style.bottom, '88px');
  assert.equal(panel.style.bottom, '88px');
  assert.equal(above.style.bottom, '126px'); // 88 + 30 + 8
});

test('with no dock on screen the stack starts at the floor, never below it', () => {
  const { doc } = env();
  const bar = el(0, 43);
  stackAboveChrome({ doc, below: () => [null], items: () => [bar] });
  assert.equal(bar.style.bottom, '28px');
  const hiddenDock = el(0, 0);
  const bar2 = el(0, 43);
  stackAboveChrome({ doc, below: () => [hiddenDock], items: () => [bar2] });
  assert.equal(bar2.style.bottom, '28px');
  const lowDock = el(895, 5); // a dock hugging the bottom edge cannot pull the bar under 28px
  const bar3 = el(0, 43);
  stackAboveChrome({ doc, below: () => [lowDock], items: () => [bar3] });
  assert.equal(bar3.style.bottom, '28px');
});

test('it re-places on resize, on any watched box resizing, and on the dock\'s class/children changing — no polling', () => {
  const { doc, ros, mos, resize } = env();
  const tray = el(0, 0);
  const dock = el(820, 62, { querySelectorAll: (sel) => (sel.includes('dock-popover-content') ? [tray] : []) });
  const bar = el(0, 43);
  const toggle = el(0, 26);
  stackAboveChrome({ doc, below: () => [dock], items: () => [bar, toggle] });
  assert.equal(ros.length, 1);
  for (const t of [dock, tray, bar, toggle]) assert.ok(ros[0].seen.includes(t), 'every box whose size moves the stack is watched');
  assert.equal(mos.length, 1);
  assert.equal(mos[0].seen[0][0], dock);
  assert.ok(mos[0].seen[0][1].attributes && mos[0].seen[0][1].childList && mos[0].seen[0][1].subtree);

  tray.getBoundingClientRect = () => ({ top: 700, height: 120 }); // user pins a tray
  ros[0].cb();
  assert.equal(bar.style.bottom, '208px');
  tray.getBoundingClientRect = () => ({ top: 0, height: 0 });
  mos[0].cb();
  assert.equal(bar.style.bottom, '88px');
  doc.defaultView.innerHeight = 1000;
  resize();
  assert.equal(bar.style.bottom, '188px'); // 1000 - 820 + 8
  bar.getBoundingClientRect = () => ({ top: 0, height: 60 }); // the bar wraps taller
  ros[0].cb();
  assert.equal(toggle.style.bottom, '256px'); // 188 + 60 + 8
});

test('destroy stops every trigger', () => {
  const { doc, ros, mos, hasResize } = env();
  const s = stackAboveChrome({ doc, below: () => [el(820, 62)], items: () => [el(0, 43)] });
  s.destroy();
  assert.ok(ros[0].off && mos[0].off && !hasResize());
});

// Moving the bar clear of the dock put it on the map credits at a phone width (390px: play and LIVE hit
// cesium-credit-*). The credits are Google/Cesium ToS attribution and must stay visible, so they are
// bottom chrome the stack sits above, same as the dock.
test('the stack sits above the highest of all the bottom chrome it is given (dock and credits)', () => {
  const { doc, ros, mos } = env();
  const dock = el(820, 62);
  const credits = el(760, 16, { children: [el(758, 18)] });
  const bar = el(0, 43);
  stackAboveChrome({ doc, below: () => [dock, credits], items: () => [bar] });
  assert.equal(bar.style.bottom, '150px'); // 900 - 758 + 8
  assert.ok(ros[0].seen.includes(credits) && mos[0].seen.some(([t]) => t === credits));
});
