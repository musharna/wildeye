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

/** Size changes of the targets call onChange; returns a function that stops watching. No ResizeObserver (node tests): nothing to watch. */
export function observeSizeWithResizeObserver(targets, onChange) {
  if (typeof ResizeObserver !== 'function') return () => {};
  const observer = new ResizeObserver(onChange);
  for (const target of targets) observer.observe(target);
  return () => observer.disconnect();
}

/**
 * Keep `cue` visible while more of `scroller` is below its view and hidden otherwise: on scroll, and when the scroller or its children change
 * size (`observeSize(targets, onChange)`, which may return a stop function). Returns a function that stops both.
 */
export function watchMoreBelow(scroller, cue, observeSize = observeSizeWithResizeObserver) {
  const update = () => { cue.style.visibility = hasMoreBelow(scroller) ? 'visible' : 'hidden'; };
  scroller.addEventListener('scroll', update, { passive: true });
  const stopObserving = observeSize([scroller, ...scroller.children], update);
  update();
  return () => {
    scroller.removeEventListener?.('scroll', update);
    if (typeof stopObserving === 'function') stopObserving();
  };
}
