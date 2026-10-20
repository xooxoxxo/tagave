// The shared page shell for tagave.app/docs. Same tokens, fonts, mark and
// footer as the landing page (site/index.html); the styles live in docs.css.

const SITE = 'https://tagave.app';
const GITHUB = 'https://github.com/xooxoxxo/tagave';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>';

// The mark, drawn once (same drawing as the landing page, the app and the favicon).
const MARK_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="mark-body" x1="18" y1="4" x2="46" y2="62" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="var(--dew-hi)"/><stop offset=".55" stop-color="var(--dew)"/><stop offset="1" stop-color="var(--dew-lo)"/>
    </linearGradient>
    <radialGradient id="mark-sheen" cx="23" cy="17" r="20" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <symbol id="tagave-mark" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="url(#mark-body)"/>
      <circle cx="32" cy="32" r="30" fill="url(#mark-sheen)"/>
      <g fill="var(--dew-ink)">
        <path d="M26.5 50C27 38 29 25 32 13C35 25 37 38 37.5 50Z"/>
        <path d="M25 50C23.5 40 21 31 16.5 22.5C24.5 28.5 30 37.5 32.5 50Z"/>
        <path d="M39 50C40.5 40 43 31 47.5 22.5C39.5 28.5 34 37.5 31.5 50Z"/>
        <path d="M24 50.5C19.5 45 14.5 41.5 8.8 39.2C17 38 24.5 41.5 30 50.5Z"/>
        <path d="M40 50.5C44.5 45 49.5 41.5 55.2 39.2C47 38 39.5 41.5 34 50.5Z"/>
        <path d="M22 49.2Q32 47.6 42 49.2Q41 52 32 52Q23 52 22 49.2Z"/>
      </g>
      <circle cx="32" cy="32" r="29.4" fill="none" stroke="var(--rim-a)" stroke-opacity=".6" stroke-width="1.2"/>
    </symbol>
  </defs>
</svg>`;

function head({ title, description, path }) {
  const url = `${SITE}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F6F8FA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0D1115" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="tagave">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/img/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="tagave: your library, quietly in order.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/img/mark.svg">
<link rel="icon" type="image/png" sizes="48x48" href="/img/favicon-48.png">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<link rel="preload" href="/fonts/urbanist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/figtree-latin.woff2" as="font" type="font/woff2" crossorigin>
<script>
  /* Apply the saved theme before first paint so nothing flashes (same key as the landing page). */
  (function () {
    try {
      var t = localStorage.getItem('tagave-theme');
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    } catch (e) { /* storage blocked: follow the system */ }
  })();
</script>
<link rel="stylesheet" href="/docs/docs.css">
<script src="/docs/docs.js" defer></script>
</head>`;
}

function topbar(version) {
  return `<header class="topbar">
  <div class="wrap nav">
    <div class="brandline">
      <a class="brand" href="/" aria-label="tagave home"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><use href="#tagave-mark"/></svg>tagave</a>
      <span class="section">Docs${version ? `<span class="dot" aria-hidden="true">·</span><span class="ver">${escapeHtml(version)}</span>` : ''}</span>
    </div>
    <div class="navlinks">
      <a class="hide-s" href="/docs/">Docs</a>
      <a href="${GITHUB}">GitHub</a>
      <div class="theme-pill" role="radiogroup" aria-label="Colour theme">
        <span class="bubble" aria-hidden="true"></span>
        <label class="opt opt-light"><input type="radio" name="tagave-theme" value="light" aria-label="Light">${SUN}</label>
        <label class="opt opt-dark"><input type="radio" name="tagave-theme" value="dark" aria-label="Dark">${MOON}</label>
      </div>
    </div>
  </div>
</header>`;
}

function sidebar(ctx, current) {
  const groups = ctx.groups
    .map((group) => {
      const items = ctx.guides
        .filter((g) => g.group === group)
        .map((g) => {
          const here = current === g.slug;
          return `<li><a href="/docs/${g.slug}/"${here ? ' aria-current="page"' : ''}>${escapeHtml(g.title)}</a></li>`;
        })
        .join('');
      return `<div class="group"><span class="label">${group}</span><ul>${items}</ul></div>`;
    })
    .join('');
  // Open in the markup so it works without script; docs.js folds it on phones.
  return `<details class="side" open data-fold="(max-width: 860px)">
  <summary><span>Contents</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
  <nav aria-label="Guides">${groups}</nav>
</details>
<script>(function(d){if(matchMedia(d.dataset.fold).matches)d.open=false})(document.currentScript.previousElementSibling)</script>`;
}

function toc(items) {
  if (items.length < 2) return '';
  const list = items.map((i) => `<li><a href="#${i.id}">${escapeHtml(i.text)}</a></li>`).join('');
  return `<details class="toc" open data-fold="(max-width: 1199px)">
  <summary><span>On this page</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
  <nav aria-label="On this page"><span class="label">On this page</span><ul>${list}</ul></nav>
</details>
<script>(function(d){if(matchMedia(d.dataset.fold).matches)d.open=false})(document.currentScript.previousElementSibling)</script>`;
}

function footer() {
  return `<footer>
  <div class="wrap">
    <div class="top">
      <a class="brand" href="/"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><use href="#tagave-mark"/></svg>tagave</a>
      <div class="links">
        <a href="${GITHUB}">GitHub</a>
        <a href="/docs/">Documentation</a>
        <a href="${GITHUB}/releases">Releases</a>
        <a href="${GITHUB}/blob/main/LICENSE">AGPL-3.0 licence</a>
      </div>
    </div>
    <p>Metadata comes from <a href="https://musicbrainz.org">MusicBrainz</a> and <a href="https://www.discogs.com">Discogs</a>. tagave uses the Discogs API but is not affiliated with, sponsored or endorsed by Discogs. Discogs is a trademark of Zink Media, LLC.</p>
  </div>
</footer>`;
}

function shell(ctx, { title, description, path, current, body }) {
  return `${head({ title, description, path })}
<body>
${MARK_DEFS}
<a class="skip" href="#main">Skip to content</a>
${topbar(ctx.version)}
<div class="wrap layout${current ? '' : ' is-overview'}">
${sidebar(ctx, current)}
<main id="main" class="content">
${body}
</main>
</div>
${footer()}
</body>
</html>
`;
}

export function page(ctx, guide, doc) {
  const edit = `${GITHUB}/blob/main/${guide.file}`;
  const body = `<article class="doc${guide.slug === 'changelog' ? ' changelog' : ''}">
  <header class="doc-head">
    <span class="label">${escapeHtml(guide.group)}</span>
    <h1>${escapeHtml(doc.title)}</h1>${guide.slug === 'changelog' ? `\n    <p class="lede">${escapeHtml(guide.blurb)}</p>` : ''}
  </header>
  ${toc(doc.toc)}
  <div class="prose">
${doc.html}
  </div>
  <p class="edit"><a href="${edit}">Edit this page on GitHub</a></p>
</article>`;
  return shell(ctx, {
    title: `${guide.title} · tagave docs`,
    description: guide.slug === 'changelog' ? 'Every release of tagave, newest first.' : doc.description || guide.blurb,
    path: `/docs/${guide.slug}/`,
    current: guide.slug,
    body,
  });
}

export function overview(ctx) {
  const groups = ctx.groups
    .map((group) => {
      const rows = ctx.guides
        .filter((g) => g.group === group)
        .map(
          (g) => `<li><a class="row" href="/docs/${g.slug}/"><span class="row-title">${escapeHtml(g.title)}</span><span class="row-blurb">${escapeHtml(g.blurb)}</span><svg class="row-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a></li>`,
        )
        .join('');
      return `<section class="guide-group"><h2 class="label">${group}</h2><ul class="rows">${rows}</ul></section>`;
    })
    .join('');
  const body = `<article class="doc overview">
  <header class="doc-head">
    <span class="label">Documentation</span>
    <h1>tagave docs</h1>
    <p class="lede">Install it, use it and keep it running.</p>
  </header>
  ${groups}
</article>`;
  return shell(ctx, {
    title: 'tagave docs',
    description: 'Guides for installing, using and running tagave, a self-hosted music catalogue, and every release in the changelog.',
    path: '/docs/',
    current: null,
    body,
  });
}
