/**
 * Shared biology details card (spec: docs/superpowers/specs/2026-09-13-species-search-design.md).
 * Cesium's info box is off (src/main.js `infoBox: false`), so until this card the details each biology layer
 * attaches to its entities, citation and licence included, never reached the screen (verified on the live
 * site 2026-09-13). Detail mode shows the clicked entity's description, which the layer builds with escaped
 * fields and the card passes through DOMPurify (see sanitizeDescription). List mode shows "what lives here"; GBIF and iNaturalist strings only ever go through textContent.
 */
import DOMPurify from 'dompurify';

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

/**
 * Layer descriptions were written for Cesium's InfoBox, which renders them in a sandboxed iframe; this card renders
 * into the page itself, so they pass through DOMPurify first. The allow-lists are exactly what the biology layers
 * emit (b, i, small, br, span, a; href, target, rel, style, class, title). Links must be absolute http, https or
 * mailto (no relative, javascript: or data: URLs), and every surviving link opens in a new tab with no opener.
 */
export const DESCRIPTION_PURIFY_CONFIG = {
  ALLOWED_TAGS: ['b', 'i', 'small', 'br', 'span', 'a'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'style', 'class', 'title'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

// DOMPurify tests target and rel against ALLOWED_URI_REGEXP too, so they are set here, after that check.
function forceNewTabLinks(node) {
  if (node.nodeName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}

export function sanitizeDescription(html, purify) {
  purify.addHook('afterSanitizeAttributes', forceNewTabLinks);
  try {
    return purify.sanitize(html, DESCRIPTION_PURIFY_CONFIG);
  } finally {
    purify.removeHook('afterSanitizeAttributes', forceNewTabLinks);
  }
}

/** A DOMPurify instance of its own (so the hook touches no other user) bound to the window that owns doc. */
function browserSanitizer(doc) {
  const purify = DOMPurify(doc.defaultView ?? window);
  if (!purify.isSupported) throw new Error('[bio-card] DOMPurify is not supported in this window; refusing to render layer HTML');
  return (html) => sanitizeDescription(html, purify);
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

export function createDetailsCard({ viewer, layerName = (id) => id, doc = document, sanitize = browserSanitizer(doc), onDismiss = () => {}, onListEnd = () => {} }) {
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
  // The owner is told (onListEnd), after the change, whenever list or status content stops showing for any reason: the card
  // is closed or dismissed, or a marker's details replace it. "What lives here" keeps its outline exactly that long (R-7e).
  const setMode = (next) => {
    const endsList = mode === 'list' && next !== 'list';
    mode = next;
    if (endsList) onListEnd();
  };

  const reset = (heading) => {
    title.textContent = heading;
    filter.textContent = '';
    body.replaceChildren();
    foot.replaceChildren();
  };
  const close = () => { root.hidden = true; setMode(null); };

  viewer.selectedEntityChanged.addEventListener((entity) => {
    try {
      const decision = cardDecision(entity, viewer.clock.currentTime);
      if (!decision.open) {
        if (mode === 'detail') close();
        return;
      }
      const html = sanitize(decision.html);
      reset(layerName(decision.layerId));
      body.innerHTML = html;
      root.hidden = false;
      setMode('detail');
    } catch (error) {
      console.error('[bio-card] could not render details', { layerId: entity?.entityCollection?.owner?.name ?? null, entityId: entity?.id ?? null, error });
    }
  });
  // Closing a detail card also clears the selection: Cesium raises selectedEntityChanged only when the value
  // changes, so a card closed with its marker still selected could not be reopened by clicking that marker.
  // A visible card that is dismissed tells its owner (onDismiss), so a search the card was waiting for is cancelled
  // and cannot reopen it (R-6b).
  const dismiss = () => {
    const wasVisible = !root.hidden;
    const wasDetail = mode === 'detail';
    close();
    if (wasDetail && viewer.selectedEntity) viewer.selectedEntity = undefined;
    if (wasVisible) onDismiss();
  };
  root.querySelector('.bio-card-close').addEventListener('click', dismiss);
  // Status or list content replacing a detail card clears the selection too (R-4d), so the card and the selection
  // stay in sync. Deselect first: that raises selectedEntityChanged, whose listener closes the detail card.
  const showListContent = (heading, render) => {
    if (mode === 'detail' && viewer.selectedEntity) viewer.selectedEntity = undefined;
    reset(heading);
    render();
    root.hidden = false;
    setMode('list');
  };
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) dismiss();
  });

  return {
    element: root,
    get mode() { return mode; },
    close,
    showStatus({ heading, message, retry = null }) {
      showListContent(heading, () => {
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
      });
    },
    showList({ heading, filterLine, entries, footer, footerHref, footerNote = null, onRow }) {
      showListContent(heading, () => {
        filter.textContent = filterLine;
        renderListInto(body, listRows(entries), doc, onRow);
        if (footerNote) {
          const note = doc.createElement('span');
          note.className = 'bio-card-foot-note';
          note.textContent = footerNote;
          foot.appendChild(note);
        }
        const link = doc.createElement('a');
        link.href = footerHref;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = footer;
        foot.appendChild(link);
      });
    },
  };
}
