/**
 * Bottom-centre is one vertical stack above the bottom chrome: the command dock (with its pinned
 * trays) and the map credits → time bar → compare. Each item's `bottom` is measured from what is below
 * it, because the dock's height changes with the viewport, its voice widget pokes out of its box,
 * open trays grow it upward, and the credits (ToS attribution: must stay visible) move with the
 * layout. A constant offset put the time bar under the dock at every viewport (2026-09-23).
 *
 * `items()` lists slots bottom-to-top; a slot is an element or an array of alternates that share one
 * place (the compare pill and its panel). A hidden item keeps its place but gives up its height.
 *
 * `beside()` lists boxes with their own CSS place near the bottom (the HUD's bottom corners). Each keeps
 * that place unless it overlaps, across, something below it (chrome or a placed item); then it sits
 * above the highest such thing. On a phone the corners each span half the row and sat under the
 * Compare pill; on a desktop they are far to the sides and stay where the CSS puts them.
 */
// Any open tray takes its room, however it was opened. Counting pinned trays only let a tray opened by a
// click or a hover cover the Compare pill but its bottom 11 px (1400 px, 2026-09-28).
const TRAYS = ".panel-collapsible:not(.collapsed) .dock-popover-content";

export function stackAboveChrome({
  doc = globalThis.document,
  below,
  items,
  beside = () => [],
  gap = 8,
  floor = 28,
}) {
  const win = doc?.defaultView;
  const heightOf = (e) => e?.getBoundingClientRect?.()?.height || 0;
  const chrome = () => below().filter(Boolean);
  const chromeBoxes = () =>
    chrome().flatMap((a) => [a, ...(a.children || []), ...(a.querySelectorAll?.(TRAYS) || [])]);
  const slots = () =>
    items().map((s) => (Array.isArray(s) ? s : [s]).filter(Boolean));

  const place = () => {
    const vh = win?.innerHeight;
    const chromeRects = chromeBoxes()
      .map((e) => e.getBoundingClientRect?.())
      .filter((r) => r && r.height > 0);
    const tops = chromeRects.map((r) => r.top);
    let bottom =
      vh && tops.length
        ? Math.max(floor, Math.round(vh - Math.min(...tops) + gap))
        : floor;
    // what a box beside the stack must clear: [left, right, the bottom offset just above it]
    const under = vh ? chromeRects.map((r) => [r.left, r.right, Math.round(vh - r.top + gap)]) : [];
    for (const slot of slots()) {
      for (const e of slot) e.style.bottom = `${bottom}px`;
      const h = Math.max(0, ...slot.map(heightOf));
      if (h > 0) {
        for (const e of slot) {
          const r = e.getBoundingClientRect?.();
          if (r?.height > 0) under.push([r.left, r.right, bottom + Math.round(h) + gap]);
        }
        bottom += Math.round(h) + gap;
      }
    }
    for (const e of beside().filter(Boolean)) {
      e.style.bottom = "";
      const r = e.getBoundingClientRect?.();
      if (!r?.width) continue;
      const clear = under
        .filter(([l, rt]) => l < r.right && r.left < rt)
        .map(([, , above]) => above);
      if (!clear.length) continue;
      const own = parseFloat(win?.getComputedStyle?.(e)?.bottom) || 0;
      e.style.bottom = `${Math.max(own, ...clear)}px`;
    }
  };

  // Every box whose size moves the stack is watched: an item shown or hidden resizes too. The chrome
  // is also watched for class/children changes (pinning a tray toggles classes before it lays out).
  const ro = win?.ResizeObserver ? new win.ResizeObserver(() => place()) : null;
  for (const e of [
    ...chromeBoxes(),
    ...chrome().flatMap((a) => [...(a.querySelectorAll?.('.dock-popover-content') || [])]),
    ...slots().flat(),
    ...beside().filter(Boolean),
  ]) ro?.observe(e);
  const mo = win?.MutationObserver
    ? new win.MutationObserver(() => place())
    : null;
  for (const a of chrome())
    mo?.observe(a, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  // A tray opens with a transform (slides up, scales in); no ResizeObserver fires for that, so a stack
  // placed on its first frame ended inside the settled tray. Re-place when a chrome transition ends.
  const settled = () => place();
  const chromeAtInstall = chrome();
  for (const a of chromeAtInstall)
    for (const ev of ["transitionend", "animationend"]) a.addEventListener?.(ev, settled);
  win?.addEventListener?.("resize", place);
  place();

  return {
    place,
    destroy() {
      ro?.disconnect();
      mo?.disconnect();
      for (const a of chromeAtInstall)
        for (const ev of ["transitionend", "animationend"]) a.removeEventListener?.(ev, settled);
      win?.removeEventListener?.("resize", place);
    },
  };
}
