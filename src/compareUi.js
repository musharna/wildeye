/**
 * The Compare panel (grill Q5): a '⇆ Compare' pill above the observed-time bar opens two drape
 * pickers, each labelled with ITS OWN date (A7), and a draggable divider over the globe. All state
 * lives in the compare controller (compare.js); this only draws it and forwards input.
 */
const BTN =
  'background:#16233a;color:#cfe3ff;border:1px solid rgba(120,170,255,.4);border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit';
const dateOf = (stats) =>
  stats?.error
    ? `⚠ ${stats.error}`
    : stats?.time
      ? String(stats.time).slice(0, 10)
      : 'no date';

export function installCompareUi({
  doc = globalThis.document,
  compare,
  dataManager,
  drapes,
  container,
  onRestack = () => () => {},
  // bottom-centre chrome the pill must not sit under (the command dock and its voice widget)
  avoid = () => [],
}) {
  if (!doc || !container)
    throw new Error(
      'installCompareUi: needs a document and the globe container',
    );
  if (!drapes?.length || drapes.length < 2)
    throw new Error('installCompareUi: needs at least two drapes');
  const el = (tag, css, text) => {
    const e = doc.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  };
  const toggle = el(
    'button',
    `position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:30;${BTN}`,
    '⇆ Compare',
  );
  toggle.id = 'compare-toggle';
  toggle.title = 'Swipe between two map layers';
  const panel = el(
    'div',
    'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:30;gap:8px;align-items:center;' +
      'padding:6px 10px;border-radius:8px;background:rgba(8,12,18,0.82);color:#cfe3ff;' +
      'font:12px/1.2 var(--font-mono, ui-monospace, monospace);border:1px solid rgba(120,170,255,0.35)',
  );
  panel.id = 'compare-panel';
  const side = (cls) => {
    const select = el('select', BTN);
    select.className = `cmp-${cls}`;
    for (const d of drapes) {
      const o = el('option', null, d.name);
      o.value = d.id;
      select.appendChild(o);
    }
    const date = el('span', 'min-width:7em;opacity:.8');
    date.className = `cmp-${cls}-date`;
    return { select, date };
  };
  const L = side('left');
  const R = side('right');
  const close = el('button', BTN, '✕');
  close.className = 'cmp-close';
  close.title = 'End compare';
  for (const n of [
    L.date,
    L.select,
    el('span', null, '⇆'),
    R.select,
    R.date,
    close,
  ])
    panel.appendChild(n);
  const divider = el(
    'div',
    'position:absolute;top:0;bottom:0;width:4px;margin-left:-2px;background:rgba(207,227,255,.9);' +
      'box-shadow:0 0 6px rgba(0,0,0,.6);cursor:ew-resize;touch-action:none;z-index:25',
  );
  divider.id = 'compare-divider';
  doc.body.appendChild(toggle);
  doc.body.appendChild(panel);
  container.appendChild(divider);

  const statsOf = (id) => dataManager.getAll().find((l) => l.id === id)?.stats;
  // 8px above the highest visible edge of what it must avoid; a child can poke out of its parent's box.
  const place = () => {
    const vh = doc.defaultView?.innerHeight;
    const tops = avoid()
      .filter(Boolean)
      .flatMap((e) => [e, ...(e.children || [])])
      .map((e) => e.getBoundingClientRect?.())
      .filter((r) => r && r.height > 0)
      .map((r) => r.top);
    const bottom = vh && tops.length ? Math.max(72, Math.round(vh - Math.min(...tops) + 8)) : 72;
    toggle.style.bottom = panel.style.bottom = `${bottom}px`;
  };
  const render = () => {
    const s = compare.getState();
    place();
    toggle.style.display = s ? 'none' : '';
    panel.style.display = s ? 'flex' : 'none';
    divider.style.display = s ? 'block' : 'none';
    if (!s) return;
    L.select.value = s.left;
    R.select.value = s.right;
    L.date.textContent = dateOf(statsOf(s.left));
    R.date.textContent = dateOf(statsOf(s.right));
    divider.style.left = `${Math.round(s.position * 1000) / 10}%`;
  };
  const fail = (e) => console.error('[compare]', e);

  toggle.addEventListener('click', () => {
    const left =
      drapes.find((d) => dataManager.isEnabled(d.id))?.id ?? drapes[0].id;
    const right = drapes.find((d) => d.id !== left).id;
    compare.set(left, right).catch(fail);
  });
  const pick = (which) => () => {
    const s = compare.getState();
    if (!s) return;
    const other = which === 'left' ? 'right' : 'left';
    const v = (which === 'left' ? L : R).select.value;
    const next = { ...s, [which]: v };
    if (v === s[other]) next[other] = s[which]; // picked the other side's drape: swap
    compare.set(next.left, next.right).catch(fail);
  };
  L.select.addEventListener('change', pick('left'));
  R.select.addEventListener('change', pick('right'));
  close.addEventListener('click', () => compare.off().catch(fail));

  let dragging = false;
  divider.addEventListener('pointerdown', (e) => {
    dragging = true;
    divider.setPointerCapture?.(e.pointerId);
    e.preventDefault?.();
  });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = container.getBoundingClientRect();
    compare.move((e.clientX - r.left) / r.width);
  });
  const stop = () => {
    dragging = false;
  };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);

  compare.subscribe(render);
  dataManager.subscribe(render);
  onRestack(render);
  doc.defaultView?.addEventListener?.('resize', render);
  // The dock settles after install (loading cover, first-run, voice widget) with no event to hear.
  doc.defaultView?.setInterval?.(place, 1000);
  render();
  return { toggle, panel, divider, render };
}
