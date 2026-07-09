// Pure render functions: given the current state + latest explore result, return
// HTML strings. All interactivity is wired by app.js via event delegation reading
// data-* attributes, so nothing here holds references or listeners.
import { pick, esc, getPath, fmtValue, isNumericSpec } from './util.js';

// Generic UI chrome strings (the dashboard config only supplies domain nouns).
export const UI = {
  en: {
    overview: 'Overview', table: 'Collection', map: 'Map', reset: 'Reset all',
    filters: 'Filters', prev: 'Previous', next: 'Next', page: 'Page', of: 'of',
    noResults: 'No matches', noResultsSub: 'Try loosening your filters.',
    sortBy: 'Sort', search: 'Search…', results: 'results', result: 'result',
    showing: 'Showing', avg: 'avg', distribution: 'Distribution', close: 'Close',
    openIn: 'Open', asc: '↑', desc: '↓',
  },
  fr: {
    overview: 'Aperçu', table: 'Collection', map: 'Carte', reset: 'Tout réinitialiser',
    filters: 'Filtres', prev: 'Précédent', next: 'Suivant', page: 'Page', of: 'sur',
    noResults: 'Aucun résultat', noResultsSub: 'Essayez d’élargir vos filtres.',
    sortBy: 'Tri', search: 'Rechercher…', results: 'résultats', result: 'résultat',
    showing: 'Affichage', avg: 'moy.', distribution: 'Répartition', close: 'Fermer',
    openIn: 'Ouvrir', asc: '↑', desc: '↓',
  },
};
export const ui = (locale) => UI[locale] || UI.en;

// ── view tabs ─────────────────────────────────────────────────────────────
export function viewTabs(state, config, locale) {
  const u = ui(locale);
  const tabs = [['overview', u.overview], ['table', u.table]];
  if (config.map) tabs.push(['map', u.map]);
  return tabs.map(([id, label]) =>
    `<button class="sl-tab" role="tab" data-role="view" data-view="${id}" aria-selected="${state.view === id}">${esc(label)}</button>`
  ).join('');
}

// ── toolbar ───────────────────────────────────────────────────────────────
export function toolbar(state, config, result, locale) {
  const u = ui(locale);
  const t = config.i18n?.[locale] || config.i18n?.en || {};
  const placeholder = pick(t.searchPlaceholder, locale) || u.search;
  const n = result?.filtered ?? 0;

  // Sort options: the primary (title) field + every metric, both directions.
  const opts = [];
  const titleField = config.record?.title;
  if (titleField) opts.push({ v: titleField, label: pick(labelForField(config, titleField), locale) || titleField });
  for (const m of config.metrics || []) {
    const lbl = pick(m.label, locale) || m.field;
    opts.push({ v: '-' + m.field, label: `${lbl} ${u.desc}` });
    opts.push({ v: m.field, label: `${lbl} ${u.asc}` });
  }
  const cur = (state.sort?.dir < 0 ? '-' : '') + (state.sort?.field || '');
  const sortSel = opts.length
    ? `<label class="sl-select-wrap"><select class="sl-select" data-role="sort" aria-label="${esc(u.sortBy)}">${
        opts.map((o) => `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
      }</select></label>`
    : '';

  return `
    <div class="sl-search">
      <span aria-hidden="true">🔎</span>
      <input type="search" data-role="q" value="${esc(state.q || '')}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
      ${state.q ? '<button class="sl-clear" data-role="clearq" aria-label="clear">×</button>' : ''}
    </div>
    <button class="sl-tab sl-facet-toggle" data-role="togglefacets">${esc(u.filters)}</button>
    ${sortSel}
    <span class="sl-count">${Number(n).toLocaleString(locale)} ${n === 1 ? u.result : u.results}</span>`;
}

// ── facet rail ────────────────────────────────────────────────────────────
export function facetsPanel(state, config, result, meta, locale) {
  const u = ui(locale);
  const chips = activeChips(state, config, meta, locale);
  const blocks = [];

  for (const f of config.facets || []) {
    const buckets = result?.facets?.[f.field]?.buckets || [];
    if (!buckets.length) continue;
    const sel = state.eq[f.field];
    const rows = buckets.map((b) => {
      const on = sel && sel.has(b.value);
      const label = f.labelsFromMeta && meta?.[f.labelsFromMeta]?.[b.value] || b.value;
      return `<label class="sl-check">
        <input type="checkbox" data-role="facet" data-field="${esc(f.field)}" data-value="${esc(b.value)}"${on ? ' checked' : ''}>
        <span class="sl-c-lbl" title="${esc(label)}">${esc(label)}</span>
        <span class="sl-c-count">${b.count.toLocaleString(locale)}</span>
      </label>`;
    }).join('');
    const hasSel = sel && sel.size;
    blocks.push(`<div class="sl-facet">
      <h3>${esc(pick(f.label, locale) || f.field)}${hasSel ? `<button class="sl-facet-reset" data-role="resetfacet" data-field="${esc(f.field)}">×</button>` : ''}</h3>
      <div class="sl-facet-list">${rows}</div>
    </div>`);
  }

  // Numeric range filters from metrics.
  const ranges = (config.metrics || []).map((m) => {
    const st = result?.stats?.[m.field];
    const lbl = pick(m.label, locale) || m.field;
    const phMin = st?.min != null ? fmtNum(st.min) : '';
    const phMax = st?.max != null ? fmtNum(st.max) : '';
    return `<div class="sl-range-row">
      <label title="${esc(lbl)}">${esc(lbl)}</label>
      <input type="number" step="any" inputmode="decimal" data-role="min" data-field="${esc(m.field)}" value="${state.min[m.field] ?? ''}" placeholder="${phMin}" aria-label="${esc(lbl)} min">
      <input type="number" step="any" inputmode="decimal" data-role="max" data-field="${esc(m.field)}" value="${state.max[m.field] ?? ''}" placeholder="${phMax}" aria-label="${esc(lbl)} max">
    </div>`;
  }).join('');

  return `
    ${chips ? `<div class="sl-facet"><h3>${esc(u.filters)}<button class="sl-facet-reset" data-role="resetall">${esc(u.reset)}</button></h3><div class="sl-active">${chips}</div></div>` : ''}
    ${blocks.join('')}
    ${ranges ? `<div class="sl-facet"><h3>${esc(pick((config.i18n?.[locale]||{}).rangesLabel, locale) || (locale==='fr'?'Fourchettes':'Ranges'))}</h3><div class="sl-range">${ranges}</div></div>` : ''}`;
}

export function activeChips(state, config, meta, locale) {
  const chips = [];
  for (const field in state.eq) {
    const f = (config.facets || []).find((x) => x.field === field);
    for (const v of state.eq[field]) {
      const label = f?.labelsFromMeta && meta?.[f.labelsFromMeta]?.[v] || v;
      chips.push(`<span class="sl-chip">${esc(label)}<button data-role="unfacet" data-field="${esc(field)}" data-value="${esc(v)}" aria-label="remove">×</button></span>`);
    }
  }
  for (const field in state.min) {
    if (state.min[field] === '' || state.min[field] == null) continue;
    const m = (config.metrics || []).find((x) => x.field === field);
    chips.push(`<span class="sl-chip">${esc(pick(m?.label, locale) || field)} ≥ ${esc(state.min[field])}<button data-role="unmin" data-field="${esc(field)}" aria-label="remove">×</button></span>`);
  }
  for (const field in state.max) {
    if (state.max[field] === '' || state.max[field] == null) continue;
    const m = (config.metrics || []).find((x) => x.field === field);
    chips.push(`<span class="sl-chip">${esc(pick(m?.label, locale) || field)} ≤ ${esc(state.max[field])}<button data-role="unmax" data-field="${esc(field)}" aria-label="remove">×</button></span>`);
  }
  return chips.join('');
}

// ── collection table ──────────────────────────────────────────────────────
export function tableView(state, config, result, meta, locale) {
  const u = ui(locale);
  if (!result || !result.filtered) return emptyState(u);
  const cols = config.columns?.length ? config.columns : autoColumns(config);
  const idField = config.idField || 'id';

  const head = cols.map((c) => {
    const sorted = state.sort?.field === c.field;
    const arrow = sorted ? (state.sort.dir < 0 ? u.desc : u.asc) : '↕';
    const num = isNumericSpec(c);
    return `<th data-role="sortcol" data-field="${esc(c.field)}"${sorted ? ` aria-sort="${state.sort.dir < 0 ? 'descending' : 'ascending'}"` : ''} class="${num ? 'sl-num' : ''}">${esc(pick(c.label, locale) || c.field)} <span class="sl-arrow">${arrow}</span></th>`;
  }).join('');

  const body = result.rows.map((row) => {
    const id = getPath(row, idField);
    const tds = cols.map((c) => {
      const raw = getPath(row, c.field);
      const num = isNumericSpec(c);
      const val = fmtValue(raw, c, meta, locale);
      const cls = [num ? 'sl-num' : '', c.primary ? 'sl-td-primary' : ''].filter(Boolean).join(' ');
      if (c.field === config.record?.badge && raw) return `<td class="${cls}"><span class="sl-badge">${esc(val)}</span></td>`;
      return `<td class="${cls}">${esc(val)}</td>`;
    }).join('');
    return `<tr data-role="row" data-id="${esc(id)}">${tds}</tr>`;
  }).join('');

  return `<div class="sl-tablewrap">
    <div class="sl-scroll"><table class="sl-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${pager(state, result, locale)}
  </div>`;
}

function pager(state, result, locale) {
  const u = ui(locale);
  if (result.pages <= 1) return '';
  return `<div class="sl-pager">
    <button data-role="prev"${result.page <= 1 ? ' disabled' : ''}>← ${esc(u.prev)}</button>
    <span class="sl-pageinfo">${esc(u.page)} ${result.page.toLocaleString(locale)} ${esc(u.of)} ${result.pages.toLocaleString(locale)}</span>
    <button data-role="next"${result.page >= result.pages ? ' disabled' : ''}>${esc(u.next)} →</button>
  </div>`;
}

function emptyState(u) {
  return `<div class="sl-tablewrap"><div class="sl-empty-state"><strong>${esc(u.noResults)}</strong>${esc(u.noResultsSub)}</div></div>`;
}

// ── overview ──────────────────────────────────────────────────────────────
export function overviewView(state, config, result, meta, locale) {
  const u = ui(locale);
  if (!result) return '';
  const cards = [];

  // KPI tiles: filtered count + average of each metric over the filtered set.
  const tiles = [`<div class="sl-metric"><div class="sl-m-val">${(result.filtered).toLocaleString(locale)}</div><div class="sl-m-lbl">${esc(u.results)}</div></div>`];
  for (const m of (config.metrics || []).slice(0, 5)) {
    const st = result.stats?.[m.field];
    if (!st || st.avg == null) continue;
    tiles.push(`<div class="sl-metric"><div class="sl-m-val">${fmtValue(st.avg, m, meta, locale)}</div><div class="sl-m-lbl">${esc(pick(m.label, locale) || m.field)} · ${esc(u.avg)}</div></div>`);
  }
  cards.push(`<div class="sl-card" style="grid-column:1/-1"><h3>${esc(u.overview)}</h3><div class="sl-metric-grid">${tiles.join('')}</div></div>`);

  for (const ch of config.charts || []) {
    if (ch.source === 'facet') {
      const buckets = result.facets?.[ch.field]?.buckets || [];
      if (buckets.length) cards.push(barCard(ch, buckets, config, meta, locale));
    } else if (ch.source === 'stat') {
      const st = result.stats?.[ch.field];
      if (st?.bins) cards.push(histCard(ch, st, config, locale));
    }
  }
  return `<div class="sl-cards">${cards.join('')}</div>`;
}

function barCard(ch, buckets, config, meta, locale) {
  const facet = (config.facets || []).find((f) => f.field === ch.field);
  const top = buckets.slice(0, ch.limit || 10);
  const maxC = top[0]?.count || 1;
  const rows = top.map((b) => {
    const label = facet?.labelsFromMeta && meta?.[facet.labelsFromMeta]?.[b.value] || b.value;
    const pct = Math.max(2, (b.count / maxC) * 100);
    return `<div class="sl-bar-row">
      <span class="sl-bar-lbl" data-role="barfilter" data-field="${esc(ch.field)}" data-value="${esc(b.value)}" title="${esc(label)}">${esc(label)}</span>
      <span class="sl-bar-track"><span class="sl-bar-fill" style="width:${pct}%"></span></span>
      <span class="sl-bar-val">${b.count.toLocaleString(locale)}</span>
    </div>`;
  }).join('');
  return `<div class="sl-card"><h3>${esc(pick(ch.title, locale))}</h3>${rows}</div>`;
}

function histCard(ch, st, config, locale) {
  const u = ui(locale);
  const max = Math.max(...st.bins) || 1;
  const bars = st.bins.map((c) => `<div class="sl-hist-bar" style="height:${Math.max(2, (c / max) * 100)}%" title="${c.toLocaleString(locale)}"></div>`).join('');
  const spec = (config.metrics || []).find((m) => m.field === ch.field) || {};
  return `<div class="sl-card"><h3>${esc(pick(ch.title, locale) || u.distribution)}</h3>
    <div class="sl-hist">${bars}</div>
    <div class="sl-hist-axis"><span>${esc(fmtValue(st.min, spec, null, locale))}</span><span>${esc(fmtValue(st.max, spec, null, locale))}</span></div>
  </div>`;
}

// ── map shell (canvas filled by map.js) ───────────────────────────────────
export function mapView(config, locale) {
  const u = ui(locale);
  const cl = pick(config.map?.colorLabel, locale) || '';
  const zoom = locale === 'fr' ? 'Zoom' : 'Zoom';
  return `<div class="sl-mapwrap">
    <canvas data-role="scatter"></canvas>
    <div class="sl-mapctrl" role="group" aria-label="${esc(zoom)}">
      <button type="button" data-role="zoomin" aria-label="${locale === 'fr' ? 'Zoomer' : 'Zoom in'}">+</button>
      <button type="button" data-role="zoomout" aria-label="${locale === 'fr' ? 'Dézoomer' : 'Zoom out'}">−</button>
      <button type="button" data-role="zoomreset" aria-label="${locale === 'fr' ? 'Réinitialiser' : 'Reset'}">⟳</button>
    </div>
    <div class="sl-maphint">${locale === 'fr' ? 'Molette pour zoomer · glisser pour déplacer' : 'Scroll to zoom · drag to pan'}</div>
    ${config.map?.colorBy ? `<div class="sl-maplegend" data-role="legend"><div>${esc(cl)}</div><div class="sl-legend-bar"></div><div class="sl-legend-ends"><span data-role="legmin"></span><span data-role="legmax"></span></div></div>` : ''}
  </div>`;
}

// ── detail modal ──────────────────────────────────────────────────────────
export function detailModal(record, config, meta, locale) {
  const u = ui(locale);
  const t = config.i18n?.[locale] || {};
  const title = fmtValue(getPath(record, config.record?.title), null, meta, locale);
  const subRaw = config.record?.subtitle ? getPath(record, config.record.subtitle) : '';
  const badgeRaw = config.record?.badge ? getPath(record, config.record.badge) : '';

  const metrics = (config.metrics || []).map((m) => {
    const raw = getPath(record, m.field);
    const has = raw != null && raw !== '';
    return `<div class="sl-metric"><div class="sl-m-val${has ? '' : ' sl-empty'}">${has ? esc(fmtValue(raw, m, meta, locale)) : '—'}</div><div class="sl-m-lbl">${esc(pick(m.label, locale) || m.field)}</div></div>`;
  }).join('');

  // Remaining scalar attributes not already shown as title/subtitle/badge/metric.
  const shown = new Set([config.record?.title, config.record?.subtitle, config.record?.badge, config.map?.lat, config.map?.lon, ...(config.metrics || []).map((m) => m.field)].filter(Boolean));
  const attrRows = [];
  for (const k in record) {
    if (shown.has(k)) continue;
    const v = record[k];
    if (v == null || typeof v === 'object') continue;
    const col = (config.columns || []).find((c) => c.field === k);
    attrRows.push(`<tr><th>${esc(pick(col?.label, locale) || k)}</th><td>${esc(fmtValue(v, col, meta, locale))}</td></tr>`);
  }

  const hasGeo = config.map && Number.isFinite(Number(getPath(record, config.map.lat)));
  const homeUrl = config.branding?.homeUrl;

  return `<div class="sl-modal-head">
      <div><h2>${esc(title)}</h2>${subRaw ? `<div class="sl-modal-sub">${esc(subRaw)}</div>` : ''}</div>
      ${badgeRaw ? `<span class="sl-badge">${esc(badgeRaw)}</span>` : ''}
      <button class="sl-modal-close" data-role="closemodal" aria-label="${esc(u.close)}">×</button>
    </div>
    <div class="sl-modal-body">
      ${hasGeo ? '<canvas class="sl-minimap" data-role="minimap"></canvas>' : ''}
      ${metrics ? `<div class="sl-metric-grid">${metrics}</div>` : ''}
      ${attrRows.length ? `<table class="sl-attrs">${attrRows.join('')}</table>` : ''}
    </div>`;
}

// ── helpers ───────────────────────────────────────────────────────────────
function labelForField(config, field) {
  const c = (config.columns || []).find((x) => x.field === field);
  if (c) return c.label;
  const m = (config.metrics || []).find((x) => x.field === field);
  return m ? m.label : field;
}
function autoColumns(config) {
  const cols = [];
  if (config.record?.title) cols.push({ field: config.record.title, primary: true });
  if (config.record?.badge) cols.push({ field: config.record.badge });
  for (const m of (config.metrics || []).slice(0, 4)) cols.push({ field: m.field, label: m.label, format: m.format, unit: m.unit });
  return cols;
}
function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(3);
}
