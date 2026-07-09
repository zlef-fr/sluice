// Server-side render of the dashboard shell. We inject the theme (config palette
// → CSS custom properties, so the whole SPA is skinned before a single byte of JS
// runs — no flash of unstyled/wrong-theme content), the resolved-locale chrome,
// the feed meta, and the first page of data. The client script hydrates the
// interactive parts from window.__SLUICE__ without a second round-trip on load.

// Resolve a label that may be a bare string or an {en,fr,…} map.
export function pick(val, locale, fallback = 'en') {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val[locale] ?? val[fallback] ?? Object.values(val)[0] ?? '';
  return String(val);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// palette key → CSS var name
const VARS = {
  bg: '--bg', surface: '--surface', ink: '--ink', inkSoft: '--ink-soft',
  inkMute: '--ink-mute', border: '--border', accent: '--accent',
  accentDark: '--accent-dark', accentSoft: '--accent-soft',
  danger: '--danger', dangerSoft: '--danger-soft',
};

function themeStyle(theme) {
  const p = theme.palette || {};
  const lines = [];
  for (const k in VARS) if (p[k]) lines.push(`${VARS[k]}:${p[k]};`);
  lines.push(`--radius:${theme.radius || '14px'};`);
  lines.push(`--font:${theme.font};`);
  lines.push(`--font-display:${theme.fontDisplay};`);
  return `:root{${lines.join('')}}`;
}

export function renderDashboard({ config, locale, meta, initial, requestPath, siteBase, assetVersion }) {
  const v = assetVersion ? `?v=${assetVersion}` : '';
  const t = config.i18n?.[locale] || config.i18n?.en || {};
  const title = pick(t.title, locale) || config.name;
  const subtitle = pick(t.subtitle, locale) || '';
  const logoText = pick(config.branding?.logoText, locale) || config.name;
  const homeUrl = config.branding?.homeUrl || '';
  const homeLabel = pick(config.branding?.homeLabel, locale) || 'Home';
  const footer = pick(config.branding?.footer, locale) || '';
  const canonical = `${siteBase}${requestPath}`;
  const total = initial?.total ?? meta?.itemCount ?? 0;

  // The whole config + initial data goes to the client so hydration needs no
  // fetch. It's already public via the API, so no secrets are exposed.
  const boot = JSON.stringify({
    config, locale, meta, initial,
    feed: config.feed, siteBase,
  }).replace(/</g, '\\u003c');

  const fontLink = config.theme.fontUrl
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(config.theme.fontUrl)}">`
    : '';

  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!--zlef-seo-->
<title>${esc(title)} · ${esc(logoText)}</title>
<meta name="description" content="${esc(subtitle)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(subtitle)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="https://assets.zlef.fr/og-default.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(subtitle)}">
<link rel="icon" href="https://assets.zlef.fr/favicon.svg" type="image/svg+xml">
<link rel="icon" href="https://assets.zlef.fr/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="https://assets.zlef.fr/apple-touch-icon.png">
<link rel="manifest" href="https://assets.zlef.fr/site.webmanifest">
<!--/zlef-seo-->
<meta name="theme-color" content="${esc(config.theme.palette?.accent || '#111')}">
${fontLink}
<link rel="stylesheet" href="/d/_assets/app.css${v}">
<!-- theme injected AFTER app.css so the config palette wins the :root cascade -->
<style>${themeStyle(config.theme)}</style>
</head>
<body>
<div id="sl-root" data-view="overview">
  <header class="sl-topbar">
    <a class="sl-brand" href="${esc(requestPath)}">${esc(logoText)}</a>
    <nav class="sl-viewtabs" aria-label="views"></nav>
    <div class="sl-topbar-right">
      ${homeUrl ? `<a class="sl-home" href="${esc(homeUrl)}" rel="noopener">${esc(homeLabel)} <span aria-hidden="true">→</span></a>` : ''}
    </div>
  </header>

  <main class="sl-main">
    <section class="sl-hero">
      <h1 class="sl-title">${esc(title)}</h1>
      ${subtitle ? `<p class="sl-subtitle">${esc(subtitle)}</p>` : ''}
      <div class="sl-hero-stats" id="sl-hero-stats">
        <div class="sl-stat"><span class="sl-stat-num">${Number(total).toLocaleString(locale)}</span><span class="sl-stat-lbl">${esc(pick(t.recordsLabel, locale) || 'records')}</span></div>
      </div>
    </section>

    <div class="sl-toolbar" id="sl-toolbar" hidden></div>

    <div class="sl-layout">
      <aside class="sl-facets" id="sl-facets" aria-label="filters"></aside>
      <div class="sl-content" id="sl-content">
        <div class="sl-skeleton" aria-hidden="true">
          ${Array.from({ length: 8 }, () => '<div class="sl-skel-row"></div>').join('')}
        </div>
      </div>
    </div>
  </main>

  <footer class="sl-footer">
    <span>${esc(footer)}</span>
    <a class="sl-powered" href="https://sluice.zlef.fr" rel="noopener">powered by <strong>Sluice</strong></a>
  </footer>
</div>

<div class="sl-modal" id="sl-modal" hidden><div class="sl-modal-card" role="dialog" aria-modal="true"></div></div>

<script>window.__SLUICE__=${boot};</script>
<script src="/d/_assets/dashboard.bundle.js${v}" defer></script>
</body>
</html>`;
}
