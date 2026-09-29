import test from 'node:test';
import assert from 'node:assert/strict';
import { MORE_SLACK_PX, hasMoreBelow, observeEndWithIntersectionObserver, watchMoreBelow } from './moreCue.js';

// A scroller with the few DOM calls moreCue.js makes: children, appendChild, remove, attributes, style, scroll listeners.
function fakeElement(tagName) {
  const el = {
    tagName, children: [], attributes: {}, style: {}, listeners: {}, parent: null,
    ownerDocument: { createElement: (tag) => fakeElement(tag.toUpperCase()) },
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    remove() { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
    addEventListener(type, fn) { el.listeners[type] = fn; },
    removeEventListener(type, fn) { if (el.listeners[type] === fn) delete el.listeners[type]; },
  };
  return el;
}

function fakeObserverClass() {
  const made = [];
  class Observer {
    constructor(callback, options) { Object.assign(this, { callback, options, targets: [], disconnected: false }); made.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  return { Observer, made };
}

// 2026-09-28: the cue went stale when the end of the content moved with no content box changing size (a margin or padding at the end):
// a ResizeObserver over the scroller and its children never fired. The end is now watched where it is: a marker after the last child,
// reported by an IntersectionObserver rooted at the scroller whenever it crosses the line hasMoreBelow draws, however it got there.
test('the end of a scroller\'s content is watched by a marker after its last child, on the line hasMoreBelow draws', () => {
  const { Observer, made } = fakeObserverClass();
  const body = fakeElement('DIV');
  const last = body.appendChild(fakeElement('P'));
  let changes = 0;
  const stop = observeEndWithIntersectionObserver(body, () => { changes += 1; }, { Observer, computedStyle: () => ({ rowGap: '8px', paddingBottom: '0px' }) });
  assert.equal(body.children.length, 2);
  assert.equal(body.children[0], last, 'the content stays first');
  const end = body.children[1];
  assert.equal(end.tagName, 'DIV');
  assert.equal(end.attributes['aria-hidden'], 'true');
  assert.equal(end.style.height, '0px');
  assert.equal(end.style.marginTop, '-8px', 'the flex gap in front of the marker is cancelled, so it adds nothing to scrollHeight');
  assert.equal(made.length, 1);
  assert.equal(made[0].options.root, body);
  // No bottom padding: hasMoreBelow says "more" once the end is more than MORE_SLACK_PX below the view.
  assert.equal(made[0].options.rootMargin, `0px 0px ${MORE_SLACK_PX}px 0px`);
  assert.deepEqual(made[0].targets, [end]);
  made[0].callback([{ isIntersecting: false }]);
  assert.equal(changes, 1, 'a crossing calls onChange');
  stop();
  assert.equal(made[0].disconnected, true);
  assert.deepEqual(body.children, [last], 'stopping removes the marker');
});

test('a list scroller gets a list-item marker, and its bottom padding moves the line up', () => {
  const { Observer, made } = fakeObserverClass();
  const rows = fakeElement('OL');
  rows.appendChild(fakeElement('LI'));
  observeEndWithIntersectionObserver(rows, () => {}, { Observer, computedStyle: () => ({ rowGap: '2px', paddingBottom: '3px' }) });
  assert.equal(rows.children[1].tagName, 'LI', 'an <ol> holds only list items');
  assert.equal(rows.children[1].style.marginTop, '-2px');
  // scrollHeight counts the 3 px of padding after the end, so at the end of the range the end sits 3 px above the view's bottom edge.
  assert.equal(made[0].options.rootMargin, `0px 0px ${MORE_SLACK_PX - 3}px 0px`);
  // The line, checked against hasMoreBelow on the same geometry: end 3 px + slack above/below the bottom edge.
  const clientHeight = 100;
  const at = (endTop) => ({ inView: endTop <= clientHeight + MORE_SLACK_PX - 3, more: hasMoreBelow({ scrollTop: 0, scrollHeight: endTop + 3, clientHeight }) });
  assert.deepEqual([at(99), at(100), at(101)].map((s) => [s.inView, s.more]), [[true, false], [false, true], [false, true]]);
});

// qa-species 2026-09-28 (branch build, 400x800 and 375x667): with the padding read once, a 60 px bottom padding added at the end of the scroll
// left the line where it was and the marker did not move, so nothing fired. The scroller's own box is watched too: a padding or gap change on a
// scroller that scrolls (its height capped) resizes its content box; the gap and padding are read again, the line redrawn and the cue rechecked.
test('a change to the scroller\'s padding or gap redraws the line and rechecks the cue', () => {
  const { Observer, made } = fakeObserverClass();
  const resizes = [];
  class Resize { constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; resizes.push(this); } observe(target) { this.targets.push(target); } disconnect() { this.disconnected = true; } }
  const body = fakeElement('DIV');
  body.appendChild(fakeElement('P'));
  let style = { rowGap: '8px', paddingBottom: '0px' };
  let changes = 0;
  const stop = observeEndWithIntersectionObserver(body, () => { changes += 1; }, { Observer, Resize, computedStyle: () => style });
  assert.equal(resizes.length, 1);
  assert.deepEqual(resizes[0].targets, [body], 'the scroller alone, not its children');
  const before = changes;
  resizes[0].callback([]);
  assert.equal(made.length, 1, 'positive control: an unchanged box keeps its line');
  assert.equal(changes, before + 1, 'and the cue is rechecked');
  style = { rowGap: '2px', paddingBottom: '60px' };
  resizes[0].callback([]);
  assert.equal(made.length, 2, 'a new line');
  assert.equal(made[0].disconnected, true, 'the old line is dropped');
  assert.equal(made[1].options.rootMargin, `0px 0px ${MORE_SLACK_PX - 60}px 0px`);
  assert.deepEqual(made[1].targets, [body.children[1]]);
  assert.equal(body.children[1].style.marginTop, '-2px');
  assert.equal(changes, before + 2);
  stop();
  assert.equal(made[1].disconnected && resizes[0].disconnected, true);
  assert.equal(body.children.length, 1);
});

test('no IntersectionObserver (node, old browsers): nothing is watched and no marker is added', () => {
  const body = fakeElement('DIV');
  body.appendChild(fakeElement('P'));
  const stop = observeEndWithIntersectionObserver(body, () => {}, { Observer: undefined, computedStyle: () => ({}) });
  assert.equal(body.children.length, 1);
  assert.equal(typeof stop, 'function');
});

// The failure the marker exists for: at the end of the range, the last child gains a bottom margin. No scroll event, no size change; only
// the end moving tells the cue. Positive control: the same watcher shows the cue for a scroller that starts cut.
test('the cue follows the end of the content when it moves without a scroll or a size change', () => {
  const body = fakeElement('DIV');
  const cue = { style: {} };
  const watched = [];
  const observeEnd = (scroller, onChange) => { const entry = { scroller, onChange, stopped: false }; watched.push(entry); return () => { entry.stopped = true; }; };
  Object.assign(body, { scrollTop: 0, scrollHeight: 616, clientHeight: 500 });
  const stop = watchMoreBelow(body, cue, observeEnd);
  assert.equal(cue.style.visibility, 'visible', 'positive control: a cut body shows the cue');
  assert.equal(watched.length, 1);
  assert.equal(watched[0].scroller, body);
  body.scrollTop = 116;
  body.listeners.scroll();
  assert.equal(cue.style.visibility, 'hidden', 'at the end');
  body.scrollHeight = 676; // the last child's margin-bottom: 60px
  watched[0].onChange([{ isIntersecting: false }]);
  assert.equal(cue.style.visibility, 'visible', 'the end moved 60 px below the view: the cue comes back');
  stop();
  assert.equal(watched[0].stopped, true);
  assert.equal(body.listeners.scroll, undefined);
});
