// Dashboard client. Hydrates from window.__SLUICE__ (config + first page baked in
// by the SSR shell, so load needs no fetch), keeps state ↔ URL in sync for deep
// links, and re-queries Sluice's /api/explore on every interaction. All events go
// through delegation; re-renders preserve input focus/caret so typing is smooth.
import { fetchExplore, fetchPoints, fetchRecord } from './api.js';
import { makeRamp, debounce } from './util.js';
import { createScatter } from './map.js';
import {
  viewTabs, toolbar, facetsPanel, tableView, overviewView, mapView, detailModal, ui,
} from './views.js';

const BOOT = window.__SLUICE__;
const { config, locale, meta } = BOOT;
const ramp = makeRamp('--accent', '--danger');

const els = {
  root: document.getElementById('sl-root'),
  tabs: document.querySelector('.sl-viewtabs'),
  toolbar: document.getElementById('sl-toolbar'),
  facets: document.getElementById('sl-facets'),
  content: document.getElementById('sl-content'),
  modal: document.getElementById('sl-modal'),
  modalCard: document.querySelector('#sl-modal .sl-modal-card'),
};

// ── state ─────────────────────────────────────────────────────────────────
const state = {
  view: 'overview',
  q: '', eq: {}, min: {}, max: {},
  sort: null, page: 1, pageSize: 50,
  recordId: null,
  result: BOOT.initial || null,
};

function defaultSort() {
  const s = config.sort?.default;
  if (!s) return null;
  return String(s).startsWith('-') ? { field: s.slice(1), dir: -1 } : { field: s, dir: 1 };
}

// ── URL ↔ state ─────────────────────────────────────────────────────────────
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.view = p.get('view') || 'overview';
  state.q = p.get('q') || '';
  state.page = parseInt(p.get('page'), 10) || 1;
  state.recordId = p.get('record');
  const sort = p.get('sort');
  state.sort = sort ? (sort.startsWith('-') ? { field: sort.slice(1), dir: -1 } : { field: sort, dir: 1 }) : defaultSort();
  state.eq = {}; state.min = {}; state.max = {};
  for (const [k, v] of p) {
    if (k.startsWith('eq.')) state.eq[k.slice(3)] = new Set(v.split(',').filter(Boolean));
    else if (k.startsWith('min.')) state.min[k.slice(4)] = v;
    else if (k.startsWith('max.')) state.max[k.slice(4)] = v;
  }
  if (config.map ? false : state.view === 'map') state.view = 'overview';
}

function writeUrl(replace) {
  const p = new URLSearchParams();
  if (state.view && state.view !== 'overview') p.set('view', state.view);
  if (state.q) p.set('q', state.q);
  for (const f in state.eq) if (state.eq[f].size) p.set('eq.' + f, [...state.eq[f]].join(','));
  for (const f in state.min) if (state.min[f] !== '' && state.min[f] != null) p.set('min.' + f, state.min[f]);
  for (const f in state.max) if (state.max[f] !== '' && state.max[f] != null) p.set('max.' + f, state.max[f]);
  if (state.sort) { const d = defaultSort(); if (!d || d.field !== state.sort.field || d.dir !== state.sort.dir) p.set('sort', (state.sort.dir < 0 ? '-' : '') + state.sort.field); }
  if (state.page > 1) p.set('page', state.page);
  if (state.recordId) p.set('record', state.recordId);
  const url = location.pathname + (p.toString() ? '?' + p : '');
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

// ── render ───────────────────────────────────────────────────────────────────
// Re-render toolbar + facets while preserving the focused input's caret, so a
// live search/range edit isn't interrupted by the rebuild.
function withFocus(fn) {
  const a = document.activeElement;
  const key = a && a.dataset && a.dataset.role
    ? { role: a.dataset.role, field: a.dataset.field || '', s: a.selectionStart, e: a.selectionEnd }
    : null;
  fn();
  if (key) {
    const sel = `[data-role="${key.role}"]${key.field ? `[data-field="${key.field}"]` : ''}`;
    const next = els.toolbar.querySelector(sel) || els.facets.querySelector(sel);
    if (next) {
      next.focus();
      try { if (key.s != null) next.setSelectionRange(key.s, key.e); } catch {}
    }
  }
}

function renderChrome() {
  withFocus(() => {
    els.tabs.innerHTML = viewTabs(state, config, locale);
    els.toolbar.hidden = false;
    els.toolbar.innerHTML = toolbar(state, config, state.result, locale);
    els.facets.innerHTML = facetsPanel(state, config, state.result, meta, locale);
  });
}

let scatter = null;
function renderContent() {
  els.root.dataset.view = state.view;
  if (state.view === 'map' && config.map) {
    els.content.innerHTML = mapView(config, locale);
    initMap();
  } else if (state.view === 'table') {
    els.content.innerHTML = tableView(state, config, state.result, meta, locale);
  } else {
    els.content.innerHTML = overviewView(state, config, state.result, meta, locale);
  }
}

function renderAll() { renderChrome(); renderContent(); }

// ── data ─────────────────────────────────────────────────────────────────────
let ctrl = null;
const scheduleApply = debounce(() => apply(), 260);

async function apply({ push = true, replace = false } = {}) {
  if (push) writeUrl(replace);
  if (ctrl) ctrl.abort();
  ctrl = new AbortController();
  els.content.classList.add('sl-busy');
  try {
    state.result = await fetchExplore(state, config, ctrl.signal);
    els.content.classList.remove('sl-busy');
    renderAll();
  } catch (e) {
    if (e.name !== 'AbortError') { els.content.classList.remove('sl-busy'); console.error(e); }
  }
}

// clamp page into range then refetch (pager only)
function goPage(delta) {
  const pages = state.result?.pages || 1;
  state.page = Math.max(1, Math.min(pages, state.page + delta));
  apply();
  els.content.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── map ──────────────────────────────────────────────────────────────────────
let pointsCache = null;
let pointsKey = '';
function filterKey() {
  return JSON.stringify([state.q, Object.fromEntries(Object.entries(state.eq).map(([k, v]) => [k, [...v]])), state.min, state.max]);
}
async function loadPoints() {
  const key = filterKey();
  if (pointsCache && pointsKey === key) return pointsCache;
  const d = await fetchPoints(state, config, undefined);
  pointsCache = d; pointsKey = key;
  return d;
}
async function initMap() {
  const canvas = els.content.querySelector('[data-role="scatter"]');
  if (!canvas) return;
  scatter = createScatter(canvas, { ramp, onPick: (id) => openRecord(id) });
  const legBar = els.content.querySelector('.sl-legend-bar');
  if (legBar) legBar.style.background = `linear-gradient(90deg, ${ramp(0)}, ${ramp(0.5)}, ${ramp(1)})`;
  const d = await loadPoints();
  if (d) {
    scatter.setData(d);
    const min = els.content.querySelector('[data-role="legmin"]');
    const max = els.content.querySelector('[data-role="legmax"]');
    if (min && d.color) min.textContent = fmt(d.color.min);
    if (max && d.color) max.textContent = fmt(d.color.max);
  }
}
function fmt(n) { return n == null ? '' : (Number.isInteger(n) ? n : Number(n).toFixed(3)); }

// ── detail modal ─────────────────────────────────────────────────────────────
async function openRecord(id) {
  state.recordId = id;
  writeUrl();
  els.modalCard.innerHTML = '<div class="sl-modal-body"><div class="sl-skeleton"><div class="sl-skel-row"></div><div class="sl-skel-row"></div></div></div>';
  els.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  const rec = await fetchRecord(config.feed, id, config.idField || 'id');
  if (!rec) { closeModal(); return; }
  els.modalCard.innerHTML = detailModal(rec, config, meta, locale);
  const mini = els.modalCard.querySelector('[data-role="minimap"]');
  if (mini && config.map) {
    const s = createScatter(mini, { ramp, onPick: null, interactive: false });
    const d = await loadPoints();
    if (d) { s.setData(d); s.setHighlight(id); }
  }
}
function closeModal() {
  els.modal.hidden = true;
  document.body.style.overflow = '';
  if (state.recordId) { state.recordId = null; writeUrl(); }
}

// ── events (delegated) ───────────────────────────────────────────────────────
function toggleEq(field, value) {
  const set = state.eq[field] || (state.eq[field] = new Set());
  if (set.has(value)) set.delete(value); else set.add(value);
  if (!set.size) delete state.eq[field];
  state.page = 1;
}

els.root.addEventListener('click', (e) => {
  const t = e.target.closest('[data-role]');
  if (!t) return;
  const role = t.dataset.role;
  const field = t.dataset.field, value = t.dataset.value;
  switch (role) {
    case 'view': state.view = t.dataset.view; renderChrome(); renderContent(); writeUrl(); break;
    case 'clearq': state.q = ''; state.page = 1; apply(); break;
    case 'togglefacets': els.facets.classList.toggle('sl-open'); break;
    case 'facet': return; // handled on 'change'
    case 'resetfacet': delete state.eq[field]; state.page = 1; apply(); break;
    case 'unfacet': toggleEq(field, value); apply(); break;
    case 'unmin': delete state.min[field]; state.page = 1; apply(); break;
    case 'unmax': delete state.max[field]; state.page = 1; apply(); break;
    case 'resetall': state.q = ''; state.eq = {}; state.min = {}; state.max = {}; state.page = 1; apply(); break;
    case 'sortcol': {
      if (state.sort?.field === field) state.sort.dir = -state.sort.dir;
      else state.sort = { field, dir: 1 };
      state.page = 1; apply(); break;
    }
    case 'barfilter': state.view = 'table'; toggleEq(field, value); apply(); break;
    case 'prev': goPage(-1); break;
    case 'next': goPage(1); break;
    case 'zoomin': if (scatter) scatter.zoomBy(1.5); break;
    case 'zoomout': if (scatter) scatter.zoomBy(1 / 1.5); break;
    case 'zoomreset': if (scatter) scatter.reset(); break;
    case 'row': openRecord(t.dataset.id); break;
    case 'closemodal': closeModal(); break;
  }
});

els.root.addEventListener('change', (e) => {
  const t = e.target.closest('[data-role]');
  if (!t) return;
  if (t.dataset.role === 'facet') { toggleEq(t.dataset.field, t.dataset.value); apply(); }
  else if (t.dataset.role === 'sort') {
    const v = t.value;
    state.sort = v.startsWith('-') ? { field: v.slice(1), dir: -1 } : { field: v, dir: 1 };
    state.page = 1; apply();
  }
});

els.root.addEventListener('input', (e) => {
  const t = e.target.closest('[data-role]');
  if (!t) return;
  const role = t.dataset.role;
  if (role === 'q') { state.q = t.value; state.page = 1; scheduleApply(); }
  else if (role === 'min') { setBound(state.min, t.dataset.field, t.value); state.page = 1; scheduleApply(); }
  else if (role === 'max') { setBound(state.max, t.dataset.field, t.value); state.page = 1; scheduleApply(); }
});
function setBound(bag, field, v) { if (v === '') delete bag[field]; else bag[field] = v; }

els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.modal.hidden) closeModal(); });

window.addEventListener('popstate', () => {
  readUrl();
  apply({ push: false });
  if (state.recordId) openRecord(state.recordId); else closeModal();
});

// ── boot ─────────────────────────────────────────────────────────────────────
readUrl();
// The SSR baked the first page for the current URL, so paint it without a fetch.
if (state.result) { renderAll(); } else { apply({ push: false, replace: true }); }
if (state.recordId) openRecord(state.recordId);
// Warm the map points in the background so the map + detail mini-map feel instant.
if (config.map) loadPoints().catch(() => {});
