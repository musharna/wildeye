/**
 * The "more ↓" scroll cue shared by the SPECIES panel body and the details card's Top datasets rows (B1, brief B S-1): a row or label of its
 * own that never covers content, laid out at all times, whose visibility alone says whether more of a scroll container is below its view.
 */

/**
 * I2: scrollHeight and clientHeight are whole pixels rounded from fractional layout, so a scroll range of up to 2 px is rounding, not content,
 * and the scroll cue stays hidden.
 */
export const MORE_SLACK_PX = 2;

/** Whether more of a scroll container's content is below its view: more than MORE_SLACK_PX of its scroll range is left. */
export function hasMoreBelow({ scrollTop, scrollHeight, clientHeight }) {
  return scrollHeight - clientHeight - scrollTop > MORE_SLACK_PX;
}

/**
 * Calls onChange whenever the end of `scroller`'s content crosses the line hasMoreBelow draws, however it moved: a scroll, the scroller or a
 * child resizing, a child shown or hidden, a margin or padding changing. Until 2026-09-28 a ResizeObserver over the scroller and its children
 * watched instead; it sees content-box sizes only, so an end that moved with no box resizing (a bottom margin) left a stale cue.
 * An empty marker appended after the last child sits where the content ends; its top margin cancels the flex gap in front of it, so it adds
 * nothing to scrollHeight. An IntersectionObserver rooted at the scroller reports it crossing the view's bottom edge moved by MORE_SLACK_PX
 * and back up by the scroller's bottom padding (scrollHeight counts that padding after the end). The gap and padding are read again whenever
 * the scroller's own box resizes, which a padding or gap change (a breakpoint) does to a scroller that scrolls, its height being capped; the
 * line is then redrawn if it moved and onChange called. Returns a function that stops watching and removes the marker. No
 * IntersectionObserver (node tests): nothing is watched or added.
 */
export function observeEndWithIntersectionObserver(scroller, onChange, {
  Observer = globalThis.IntersectionObserver, Resize = globalThis.ResizeObserver, computedStyle = (element) => globalThis.getComputedStyle(element),
} = {}) {
  if (typeof Observer !== 'function') return () => {};
  const px = (value) => Number.parseFloat(value) || 0;
  // An <ol> or <ul> holds list items only.
  const end = scroller.ownerDocument.createElement(/^(OL|UL)$/.test(scroller.tagName) ? 'li' : 'div');
  end.setAttribute('aria-hidden', 'true');
  Object.assign(end.style, { display: 'block', flex: 'none', height: '0px', margin: '0px', padding: '0px', listStyle: 'none', pointerEvents: 'none' });
  scroller.appendChild(end);
  let observer = null;
  let line = null;
  const sync = () => {
    const style = computedStyle(scroller);
    end.style.marginTop = `${-px(style.rowGap)}px`;
    const rootMargin = `0px 0px ${MORE_SLACK_PX - px(style.paddingBottom)}px 0px`;
    if (rootMargin === line) return;
    observer?.disconnect();
    observer = new Observer(onChange, { root: scroller, rootMargin });
    observer.observe(end);
    line = rootMargin;
  };
  sync();
  const resize = typeof Resize === 'function' ? new Resize(() => { sync(); onChange(); }) : null;
  resize?.observe(scroller);
  return () => { observer.disconnect(); resize?.disconnect(); end.remove(); };
}

/**
 * Keep `cue` visible while more of `scroller` is below its view and hidden otherwise: on scroll, and whenever the end of its content moves
 * across the view's edge (`observeEnd(scroller, onChange)`, which may return a stop function). Returns a function that stops both.
 */
export function watchMoreBelow(scroller, cue, observeEnd = observeEndWithIntersectionObserver) {
  const update = () => { cue.style.visibility = hasMoreBelow(scroller) ? 'visible' : 'hidden'; };
  scroller.addEventListener('scroll', update, { passive: true });
  const stopObserving = observeEnd(scroller, update);
  update();
  return () => {
    scroller.removeEventListener?.('scroll', update);
    if (typeof stopObserving === 'function') stopObserving();
  };
}
