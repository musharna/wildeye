/**
 * Shared biology details card (spec: docs/superpowers/specs/2026-09-13-species-search-design.md).
 * Cesium's info box is off (src/main.js `infoBox: false`), so until this card the details each biology layer
 * attaches to its entities, citation and licence included, never reached the screen (verified on the live
 * site 2026-09-13). Detail mode shows the clicked entity's description, which the layer builds with escaped
 * fields. List mode shows "what lives here"; GBIF and iNaturalist strings only ever go through textContent.
 */
export const BIO_CARD_LAYER_IDS = new Set([
  'arbonet', 'birds', 'cetaceans', 'drought', 'ecoregions', 'fires', 'fishing', 'gfw', 'h5n1', 'hpai',
  'neon', 'neon-vectors', 'occurrences', 'otn', 'phenology', 'rivers', 'tracks', 'wastewater', 'whispers',
]);

export function cardDecision(entity, time = undefined) {
  const layerId = entity?.entityCollection?.owner?.name;
  if (typeof layerId !== 'string' || !BIO_CARD_LAYER_IDS.has(layerId)) return { open: false };
  const html = entity.description?.getValue?.(time);
  if (typeof html !== 'string' || !html.trim()) return { open: false };
  return { open: true, layerId, html };
}

export function listRows(entries) {
  return entries.map((entry) => ({
    key: entry.key,
    primary: entry.commonName || entry.scientificName,
    secondary: entry.commonName ? entry.scientificName : '',
    count: Number(entry.count).toLocaleString('en-US'),
    note: entry.error ? `name lookup failed: ${entry.error}` : '',
  }));
}

/** Render list rows with textContent only. */
export function renderListInto(container, rows, doc, onRow) {
  container.replaceChildren();
  for (const row of rows) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'bio-card-row';
    for (const [className, text] of [['bio-card-row-primary', row.primary], ['bio-card-row-secondary', row.secondary], ['bio-card-row-count', row.count]]) {
      const span = doc.createElement('span');
      span.className = className;
      span.textContent = text;
      button.appendChild(span);
    }
    if (row.note) {
      const note = doc.createElement('span');
      note.className = 'bio-card-row-note';
      note.textContent = row.note;
      button.appendChild(note);
    }
    button.addEventListener('click', () => onRow(row));
    container.appendChild(button);
  }
}

export function createDetailsCard({ viewer, layerName = (id) => id, doc = document }) {
  const root = doc.createElement('aside');
  root.id = 'bio-card';
  root.className = 'bio-card';
  root.hidden = true;
  root.setAttribute('aria-live', 'polite');
  // Static skeleton only; no data is interpolated here.
  root.innerHTML = '<div class="bio-card-head"><span class="bio-card-title"></span><button type="button" class="bio-card-close" aria-label="Close details">×</button></div><div class="bio-card-filter"></div><div class="bio-card-body"></div><div class="bio-card-foot"></div>';
  const title = root.querySelector('.bio-card-title');
  const filter = root.querySelector('.bio-card-filter');
  const body = root.querySelector('.bio-card-body');
  const foot = root.querySelector('.bio-card-foot');
  let mode = null;

  const reset = (heading) => {
    title.textContent = heading;
    filter.textContent = '';
    body.replaceChildren();
    foot.replaceChildren();
  };
  const close = () => { root.hidden = true; mode = null; };

  viewer.selectedEntityChanged.addEventListener((entity) => {
    try {
      const decision = cardDecision(entity, viewer.clock.currentTime);
      if (!decision.open) {
        if (mode === 'detail') close();
        return;
      }
      reset(layerName(decision.layerId));
      body.innerHTML = decision.html;
      mode = 'detail';
      root.hidden = false;
    } catch (error) {
      console.error('[bio-card] could not render details', { layerId: entity?.entityCollection?.owner?.name ?? null, entityId: entity?.id ?? null, error });
    }
  });
  root.querySelector('.bio-card-close').addEventListener('click', () => {
    const wasDetail = mode === 'detail';
    close();
    if (wasDetail && viewer.selectedEntity) viewer.selectedEntity = undefined;
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) close();
  });

  return {
    element: root,
    get mode() { return mode; },
    close,
    showStatus({ heading, message, retry = null }) {
      reset(heading);
      const text = doc.createElement('p');
      text.className = 'bio-card-status';
      text.textContent = message;
      body.appendChild(text);
      if (retry) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'bio-card-retry';
        button.textContent = 'Retry';
        button.addEventListener('click', () => retry());
        body.appendChild(button);
      }
      mode = 'list';
      root.hidden = false;
    },
    showList({ heading, filterLine, entries, footer, footerHref, onRow }) {
      reset(heading);
      filter.textContent = filterLine;
      renderListInto(body, listRows(entries), doc, onRow);
      const link = doc.createElement('a');
      link.href = footerHref;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = footer;
      foot.appendChild(link);
      mode = 'list';
      root.hidden = false;
    },
  };
}
