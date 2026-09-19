/**
 * Shared biology details card (spec: docs/superpowers/specs/2026-09-13-species-search-design.md).
 * Cesium's info box is off (src/main.js `infoBox: false`), so until this card the details each biology layer
 * attaches to its entities, citation and licence included, never reached the screen (verified on the live
 * site 2026-09-13). Detail mode shows the clicked entity's description, which the layer builds with escaped
 * fields and the card passes through DOMPurify (see sanitizeDescription). List mode shows "what lives here", with its top datasets in the
 * foot; GBIF and iNaturalist strings only ever go through textContent.
 */
import DOMPurify from 'dompurify';
import { createDatasetList } from './datasetList.js';
import { observeSizeWithResizeObserver, watchMoreBelow } from './moreCue.js';

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

/**
 * Leading pictographs (emoji and their variation selectors, zero-width joiners, keycap marks and flag letters) and spaces, removed from a
 * record's name for the spoken line. Digits and letters are kept, and so is an icon after the name.
 */
const LEADING_PICTOGRAPHS = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u20e3\s]+/u;
export function spokenName(text) {
  return typeof text === 'string' ? text.replace(LEADING_PICTOGRAPHS, '').trim() : '';
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

/**
 * Fix round 1, item 4: "3 name lookups failed (HTTP 503, timeout)" for the rows that carry an error, each distinct message once, or '' with none.
 * The card was a live region that read these out with the rows; the status line says them now.
 */
function failuresLine(rows, what) {
  const failed = rows.filter((row) => row.error);
  if (failed.length === 0) return '';
  return `${failed.length} ${what}${failed.length === 1 ? '' : 's'} failed (${[...new Set(failed.map((row) => row.error))].join(', ')})`;
}

export function createDetailsCard({ viewer, layerName = (id) => id, doc = document, sanitize = browserSanitizer(doc), onDismiss = () => {}, onListEnd = () => {}, observeSize = observeSizeWithResizeObserver, nextFrame = (fn) => setTimeout(fn, 50), cancelFrame = (id) => clearTimeout(id), isRendered = null }) {
  const root = doc.createElement('aside');
  root.id = 'bio-card';
  root.className = 'bio-card';
  root.hidden = true;
  // R13-M8: the card is not a live region (a screen reader read all of it each time it filled); it is labelled by its title, and one short line
  // in a visually hidden status region of its own, outside the card so it is heard while the card is hidden too, says what opened.
  // Fix round 1, I-1: the name holds because the card is an <aside>, role complementary (it supports the map beside it and stands on its own),
  // which takes a name; a role-less <div> is generic and would drop it.
  root.setAttribute('aria-labelledby', 'bio-card-title');
  const announcer = doc.createElement('div');
  announcer.id = 'bio-card-announce';
  announcer.className = 'bio-card-announce';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  // Fix round 1, item 3: a line identical to the one showing is not a change a screen reader hears, so it is cleared and set again a moment later
  // (50 ms, a later task than the clear, so the two are separate changes); a newer line or a close cancels that pending set.
  let pendingFrame = null;
  // Final review m-3: clean view and recording mode hide the card with display: none (style.css), and a line about a card nobody can see is
  // noise; a line is said only while the card is rendered, checked again when a repeat is set.
  const rendered = isRendered ?? (() => root.getClientRects().length > 0);
  const announce = (text) => {
    if (pendingFrame !== null) cancelFrame(pendingFrame);
    pendingFrame = null;
    if (text !== '' && !rendered()) {
      announcer.textContent = '';
      return;
    }
    if (text !== '' && announcer.textContent === text) {
      announcer.textContent = '';
      pendingFrame = nextFrame(() => { pendingFrame = null; if (rendered()) announcer.textContent = text; });
      return;
    }
    announcer.textContent = text;
  };
  // Static skeleton only; no data is interpolated here. The body and the foot share .bio-card-main, the grid that divides the card's height
  // between the species list and the Top datasets rows (style.css, R13-M1).
  root.innerHTML = '<div class="bio-card-head"><span class="bio-card-title"></span><button type="button" class="bio-card-note-info" aria-label="Why all locations" aria-expanded="false" aria-controls="bio-card-note-pop" hidden>i</button><button type="button" class="bio-card-close" aria-label="Close details">×</button></div><div class="bio-card-filter"></div><div class="bio-card-main"><div class="bio-card-body"></div><div class="bio-card-foot"></div></div><p id="bio-card-note-pop" class="bio-card-note-pop" role="note" hidden></p>';
  const title = root.querySelector('.bio-card-title');
  title.id = 'bio-card-title';
  const filter = root.querySelector('.bio-card-filter');
  const body = root.querySelector('.bio-card-body');
  const foot = root.querySelector('.bio-card-foot');
  const main = root.querySelector('.bio-card-main');
  // Fix round 6 (critic r5 N1): the folded note's text stays reachable on touch: an info button in the head shows it over the list.
  const noteInfo = root.querySelector('.bio-card-note-info');
  const notePop = root.querySelector('.bio-card-note-pop');
  noteInfo.hidden = true;
  notePop.hidden = true;
  const showNotePop = (open) => {
    notePop.hidden = !open;
    notePop.textContent = open && listFoot?.note ? listFoot.note.textContent : '';
    noteInfo.setAttribute('aria-expanded', String(open));
  };
  noteInfo.addEventListener('click', () => showNotePop(notePop.hidden));
  // Fix round 5 (critic r4 S1): what a list's card gives up, in order, when its content does not fit its box (a short window): first the Top
  // datasets block (secondary, and the gbif.org credit link carries the records), then the antimeridian note (its text moves to the credit
  // link's title; the credit itself says "all locations"). The species list keeps its one whole row (its min-height), so it gives way last.
  const FOLDS = ['bio-card--fold-datasets', 'bio-card--fold-note'];
  let listFoot = null; // { hasDatasets, note, link } of the list showing
  const fitFoot = () => {
    root.classList?.remove(...FOLDS);
    noteInfo.hidden = true;
    if (listFoot?.link && listFoot.note) listFoot.link.removeAttribute?.('title');
    if (!listFoot || root.hidden || mode !== 'list') return;
    const overflows = () => main.scrollHeight > main.clientHeight + 1;
    for (const fold of FOLDS) {
      if (!overflows()) return;
      if (fold === 'bio-card--fold-datasets' && !listFoot.hasDatasets) continue;
      if (fold === 'bio-card--fold-note' && !listFoot.note) continue;
      root.classList?.add(fold);
      if (fold === 'bio-card--fold-note') {
        listFoot.link.title = listFoot.note.textContent;
        noteInfo.hidden = false;
      }
    }
    if (noteInfo.hidden && !notePop.hidden) showNotePop(false); // the note shows again in the foot
  };
  doc.defaultView?.addEventListener?.('resize', fitFoot);
  let mode = null;
  // Brief B S-1: stops the Top datasets rows' "more ↓" cue from watching a list the card no longer shows.
  let stopDatasetsCue = null;
  const stopCue = () => { stopDatasetsCue?.(); stopDatasetsCue = null; };
  // The owner is told (onListEnd), after the change, whenever list or status content stops showing for any reason: the card
  // is closed or dismissed, or a marker's details replace it. "What lives here" keeps its outline exactly that long (R-7e).
  // The owner's handler runs inside the card's own state change, so its failure is logged here under its own label: a dismiss still
  // reaches onDismiss, and a marker's details are not reported as a render failure.
  const setMode = (next) => {
    const from = mode;
    mode = next;
    if (from !== 'list' || next === 'list') return;
    try {
      onListEnd();
    } catch (error) {
      console.error('[bio-card] onListEnd failed', { from, to: next, error });
    }
  };

  const reset = (heading) => {
    stopCue();
    listFoot = null;
    root.classList?.remove(...FOLDS);
    showNotePop(false);
    noteInfo.hidden = true;
    title.textContent = heading;
    filter.textContent = '';
    body.replaceChildren();
    foot.replaceChildren();
  };
  // Review M-4: a hidden card stops watching its rows too; the next render would otherwise be the only thing that did.
  const close = () => { root.hidden = true; stopCue(); announce(''); setMode(null); };

  viewer.selectedEntityChanged.addEventListener((entity) => {
    try {
      const decision = cardDecision(entity, viewer.clock.currentTime);
      if (!decision.open) {
        if (mode === 'detail') close();
        return;
      }
      const html = sanitize(decision.html);
      const heading = layerName(decision.layerId);
      reset(heading);
      body.innerHTML = html;
      root.hidden = false;
      // Fix round 1, item 3: the line names the record: the entity's name, else the first bold line of its details (the biology layers put the
      // record's name there), else the layer.
      // Brief B fix round 1, item 6: without the icon the layers put before a name ("🐋 Blue whale"), which a reader speaks as an emoji name.
      const record = spokenName(typeof entity.name === 'string' ? entity.name : '') || spokenName(body.querySelector('b')?.textContent) || heading;
      announce(`${record} details opened`);
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
  const showListContent = (heading, render, announcement) => {
    if (mode === 'detail' && viewer.selectedEntity) viewer.selectedEntity = undefined;
    reset(heading);
    render();
    root.hidden = false;
    announce(announcement);
    setMode('list');
    fitFoot();
  };
  // M2: an Escape another control already handled (the species search hiding its suggestions) is not the card's.
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !root.hidden) dismiss();
  });

  return {
    element: root,
    /** The card's status line (R13-M8); the page appends it beside the card. */
    announcer,
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
      }, `${heading}: ${message}`);
    },
    /** `datasets` ({ key, count, title, doi, error }, facet order) are named above the foot's gbif.org link (R-7u). */
    showList({ heading, filterLine, entries, datasets = [], footer, footerHref, footerNote = null, onRow }) {
      showListContent(heading, () => {
        filter.textContent = filterLine;
        renderListInto(body, listRows(entries), doc, onRow);
        if (datasets.length) {
          const block = foot.appendChild(createDatasetList(doc, datasets, { heading: 'Top datasets in this area' }));
          // [heading, rows, cue] (createDatasetList): the panel's cue, shown while more rows are below the rows' view.
          stopDatasetsCue = watchMoreBelow(block.children[1], block.children[2], observeSize);
        }
        let note = null;
        if (footerNote) {
          note = doc.createElement('span');
          note.className = 'bio-card-foot-note';
          note.textContent = footerNote;
          foot.appendChild(note);
        }
        const link = doc.createElement('a');
        link.href = footerHref;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = footer;
        foot.appendChild(link);
        listFoot = { hasDatasets: datasets.length > 0, note, link };
      }, `${heading}: ${[`${entries.length} species listed`, failuresLine(entries, 'name lookup'), failuresLine(datasets, 'dataset lookup')].filter(Boolean).join('; ')}`);
    },
  };
}
