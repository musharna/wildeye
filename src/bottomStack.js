/**
 * Bottom-centre is one vertical stack above the bottom chrome: the command dock (with its pinned
 * trays) and the map credits → time bar → compare. Each item's `bottom` is measured from what is below
 * it, because the dock's height changes with the viewport, its voice widget pokes out of its box,
 * pinned trays grow it upward, and the credits (ToS attribution: must stay visible) move with the
 * layout. A constant offset put the time bar under the dock at every viewport (2026-09-23).
 *
 * `items()` lists slots bottom-to-top; a slot is an element or an array of alternates that share one
 * place (the compare pill and its panel). A hidden item keeps its place but gives up its height.
 */
const TRAYS = ".dock-pinned:not(.collapsed) .dock-popover-content";

export function stackAboveChrome({
  doc = globalThis.document,
  below,
  items,
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
    const tops = chromeBoxes()
      .map((e) => e.getBoundingClientRect?.())
      .filter((r) => r && r.height > 0)
      .map((r) => r.top);
    let bottom =
      vh && tops.length
        ? Math.max(floor, Math.round(vh - Math.min(...tops) + gap))
        : floor;
    for (const slot of slots()) {
      for (const e of slot) e.style.bottom = `${bottom}px`;
      const h = Math.max(0, ...slot.map(heightOf));
      if (h > 0) bottom += Math.round(h) + gap;
    }
  };

  // Every box whose size moves the stack is watched: an item shown or hidden resizes too. The chrome
  // is also watched for class/children changes (pinning a tray toggles classes before it lays out).
  const ro = win?.ResizeObserver ? new win.ResizeObserver(() => place()) : null;
  for (const e of [
    ...chromeBoxes(),
    ...chrome().flatMap((a) => [...(a.querySelectorAll?.('.dock-popover-content') || [])]),
    ...slots().flat(),
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
  win?.addEventListener?.("resize", place);
  place();

  return {
    place,
    destroy() {
      ro?.disconnect();
      mo?.disconnect();
      win?.removeEventListener?.("resize", place);
    },
  };
}
