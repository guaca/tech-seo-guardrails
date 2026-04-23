# Checks Reference

This document lists every built-in check, what it tests, how it's configured, and what failure looks like.

Checks are divided into three test tiers:
- **Unit** (`tests/unit/seo-config.spec.ts`) — validates `seo-checks.json` structure without a browser; runs in milliseconds
- **Integration** (`tests/integration/seo-dom.spec.ts`) — renders each page in a Googlebot-emulated browser and inspects the DOM
- **E2E** (`tests/e2e/seo-links.spec.ts`) — sitemap-driven HEAD requests, no browser rendering required

## Shadow DOM traversal

All integration DOM checks automatically traverse open shadow roots. This mirrors how Googlebot processes declarative shadow DOM — it flattens the composed tree for indexing.

- **Always on** — no configuration flag is needed.
- **Open shadow roots only** — closed shadow roots are inaccessible by design (same behavior as Googlebot).
- **Informational annotation** — when elements are found inside a shadow root, the test adds a Playwright annotation (type: `Shadow DOM`) showing how many elements were found in shadow roots and which host element contained them. This is purely informational — it never causes a test to fail or warn.
- **`<head>` elements are unaffected** — canonical, meta, title, and other `<head>` tags cannot live inside shadow roots, so those checks use standard DOM access.

---

## Unit checks

Unit checks run in `tests/unit/seo-config.spec.ts` with no browser. They validate the `seo-checks.json` config file structure before any browser spins up, catching misconfigurations instantly.

### Config schema validation

| Check | What it tests |
|---|---|
| Config file exists and is valid JSON | `seo-checks.json` is present and parseable |
| `baseUrl` present | `baseUrl` is set in config or via `PROD_BASE_URL` env var |
| `pages` array not empty | At least one page is defined |
| No duplicate `path` values | All page paths are unique |
| Required page fields present | Each page has `path`, `title`, `canonical`, `metaRobots` |
| Valid canonical URLs | Each canonical is a relative path or a valid absolute URL |

### Template resolution

| Check | What it tests |
|---|---|
| Template inheritance | Page configs correctly merge template defaults |
| Deep merge | Nested check group overrides don't clobber sibling fields |
| Lane filtering | Checks with `lane: ["staging"]` are removed when `SEO_LANE=pr` |
| Disabled check removal | Checks with `enabled: false` are excluded from resolved config |
| Missing template reference | A page referencing a non-existent template fails validation |

### Page sampling

| Check | What it tests |
|---|---|
| Sampling by template | Pages are grouped by `template` and capped at `maxPagesPerTemplate` |
| `SEO_SAMPLE_LIMIT` env override | Environment variable overrides `sampleConfig.maxPagesPerTemplate` |
| No sampling when under limit | All pages run if count ≤ limit |
| Random selection | Sampling is non-deterministic (different pages each run) |
| Unassigned template group | Pages with no `template` field are grouped and sampled together |

---

## Integration checks

### How the browser session is set up

Before any integration checks run, `beforeEach` does four things:

1. **Googlebot emulation** — Playwright uses the Googlebot Smartphone user-agent, a 412×732px mobile viewport, 2.625x device pixel ratio, and touch enabled. This matches Google's mobile-first indexing crawler.

2. **Event listener setup** — Three collectors are registered before navigation:
   - Console errors (`page.on('console')`)
   - Failed network requests (`page.on('requestfailed')`)
   - Mixed content URLs (`page.on('request')`)

3. **Page ready wait** — After navigation, the test waits for the load state configured by `waitForReady` (default: `"networkidle"`). Two values are supported:
   - `"networkidle"` — waits until no network requests for 500ms; required whenever JavaScript renders or modifies any page content (headings, body text, prices, images, meta tags, JSON-LD). Use for CSR, SSR+hydration, and all JS frameworks.
   - `"load"` — waits for the `load` event (HTML + all resources downloaded); suitable for sites where all content is in the raw server HTML and JavaScript never modifies it. Slightly faster.

4. **Two-phase viewport expansion** — After the page loads, the test mirrors Googlebot's actual rendering behaviour:
   - **Phase 1**: measures `document.documentElement.scrollHeight` at 412×732
   - **Phase 2**: expands to `412 × scrollHeight`, waits one animation frame so `vh` units recalculate and `IntersectionObserver` fires
   - Both phases are annotated in the test report so you can see the exact dimensions

   If Phase 2 `scrollHeight > innerHeight`, the report shows `⚠ content grew after expansion` — this means CSS using viewport-relative units (`vh`, `dvh`) caused the page to grow as the viewport expanded. Googlebot only expands once, so that additional content is invisible to it.

---

### [crawlability] Site-level checks

These run once per test run, not per page.

| Check | What it tests | Config |
|---|---|---|
| `robots.txt accessible` | `GET /robots.txt` returns 200 or 304 and body contains `Sitemap:` | Always runs |
| `Unique page titles` | All titles in `seo-checks.json` are distinct | Always runs |
| `Unique meta descriptions` | All meta descriptions in `seo-checks.json` are distinct | Always runs |

**Common failures:**
- `robots.txt` returning 404 — your server isn't serving it
- Duplicate titles — two pages in `seo-checks.json` have the same `title` value

---

### httpChecks

**Config key:** `seo.httpChecks`

| Check | Field | Description |
|---|---|---|
| Status code | `expectedStatusCode` | Assert the page returns the expected HTTP status (usually `200` or `304`) |
| X-Robots-Tag | `xRobotsTag` | `null` = assert header absent; string = assert header equals that value |
| Max redirects | `maxRedirects` | Maximum number of redirects before failing (currently informational) |
| Canonical resolves | `canonicalMustResolve` | HEAD request to the canonical URL must return 200 or 304 |
| Allowed by robots.txt | `robotsTxtEnforcement` | Page URL must be allowed for Googlebot; no critical CSS/JS blocked |

**Example config:**
```json
"httpChecks": {
  "expectedStatusCode": { "enabled": true, "severity": "blocker", "value": 200 }, // accepts 304 automatically if 200 is expected
  "xRobotsTag": { "enabled": true, "severity": "blocker", "value": null },
  "canonicalMustResolve": { "enabled": true, "severity": "blocker", "value": true },
  "robotsTxtEnforcement": { "enabled": true, "severity": "blocker", "value": true }
}
```

**Common failures:**
- Page returns 301/302 — URL in `seo-checks.json` is not the canonical destination
- `x-robots-tag: noindex` on a page that should be indexable — check your middleware
- Canonical URL returns 404 — a canonical pointing to a non-200/304 URL is worse than no canonical
- `Disallow: /static/` in `robots.txt` blocking your CSS/JS bundle

---

### Metadata (Standard SEO Signals)

**Config key:** `seo.metadata`

These come from the page-level `seo.metadata` fields in `seo-checks.json`. All metadata checks are **always warning** by default.

| Check | Config field | Description |
|---|---|---|
| Correct `<title>` | `metadata.title` | Exact match against the page's `<title>` |
| Correct `<h1>` | `metadata.h1` | Exact match against the first `<h1>` |
| Exactly one `<h1>` | always | A page must have exactly one `<h1>` |
| Correct canonical | `metadata.canonical` | Exact match against `<link rel="canonical" href="">` |
| No Canonical Misdirection Trap | `metadata.canonical` | Asserts raw HTML canonical doesn't point to the wrong URL before hydration |
| No duplicate canonical | `maxCanonicalTags: 1` | Count of `<link rel="canonical">` must not exceed limit |
| Self-referencing canonical | `selfReferencingCanonical: true` | Canonical `href` must equal the current page URL |
| Correct meta robots | `metadata.metaRobots` | Exact match against `<meta name="robots" content="">` |
| No Meta Robots Trap | `metadata.metaRobots` | Asserts raw HTML does not contain `noindex` if expected value doesn't |
| No duplicate robots meta | `maxRobotsTags: 1` | Count of `<meta name="robots">` must not exceed limit |
| Correct meta description | `metadata.metaDescription` | Exact match (severity: warning) |
| Hreflang cluster | `metadata.hreflang` | Asserts hreflang tags exist with the correct URLs |
| meta charset | `metadata.hasCharset` | `<meta charset="">` exists |
| Viewport | `metadata.hasViewport` | `<meta name="viewport">` must exist |
| Favicon | `metadata.hasFavicon` | `<link rel="icon">` or `<link rel="shortcut icon">` must exist |
| Max title tags | `metadata.maxTitleTags` | Only one `<title>` tag allowed |

**Common failures:**
- Title is `undefined` or `null` — JavaScript template didn't render the head
- Multiple `<h1>` — layout includes a visually-hidden heading for accessibility that also gets indexed
- Two `<link rel="canonical">` — usually caused by a CMS injecting one and a head component injecting another
- Canonical points to a different page — accidental cross-page canonicalisation, often from a template bug
- Canonical missing trailing slash / `http` vs `https` mismatch
- Meta Robots Trap — raw HTML sends a `noindex` but JS later updates it to `index`, causing Google to drop the page early

---

### ogTags

**Config key:** `seo.ogTags`

Tests each key in the `tags` object against the corresponding `<meta property="og:...">` tag.

Also supports `requireImage: true` to assert `og:image` is present.

**Example config:**
```json
"ogTags": {
  "tags": {
    "enabled": true,
    "severity": "warning",
    "value": {
      "og:title": "Page Title | Site",
      "og:description": "Description.",
      "og:type": "website",
      "og:url": "https://your-site.com/"
    }
  },
  "requireImage": { "enabled": true, "severity": "warning", "value": true }
}
```

**Common failures:**
- `og:image` missing — social platforms (Slack, LinkedIn, Twitter) won't generate a preview card
- `og:url` has wrong base URL — often happens in staging environments if the URL is hardcoded

---

### twitterCards

**Config key:** `seo.twitterCards`

Tests each key in `tags` against `<meta name="twitter:...">` values.

```json
"twitterCards": {
  "tags": {
    "enabled": true,
    "severity": "warning",
    "value": {
      "twitter:card": "summary_large_image",
      "twitter:title": "Page Title | Site"
    }
  }
}
```

---

### links

**Config key:** `seo.links`

Asserts that specific links are visible on the page. Each entry requires at least one of:

- `expectedText` — finds the link by its visible text using `getByRole('link', { name })`. **Preferred**: resilient to URL and class changes.
- `selector` — finds the link by CSS selector. Use when you need to scope to a specific container (e.g. `.footer a`).

Both can be combined: `selector` scopes the search, `expectedText` is then also asserted on the found element.

**Example config:**
```json
"linkHealth": {
  "links": {
    "enabled": true,
    "severity": "blocker",
    "value": [
      { "expectedText": "About Us" },
      { "selector": ".footer a", "expectedText": "Privacy Policy" }
    ]
  }
}
```

---

### hreflang

**Config key:** `seo.hreflang`

Asserts `<link rel="alternate" hreflang="...">` tags exist with the correct URLs.

**Example config:**
```json
"metadata": {
  "hreflang": {
    "enabled": true,
    "severity": "blocker",
    "value": {
      "en": "https://your-site.com/",
      "es": "https://your-site.com/es/"
    }
  }
}
```

---

### images

**Config key:** `seo.images`

| Check | Field | Description |
|---|---|---|
| All images have alt | `allImagesHaveAlt: true` | Every `<img>` must have a non-empty `alt` |
| All images have dimensions | `allImagesHaveDimensions: true` | Every `<img>` must have explicit `width` and `height` |
| LCP image not lazy | `lcpImageNotLazy: true` | The browser-detected LCP `<img>` must not have `loading="lazy"` |
| LCP image has fetch priority | `lcpImageShouldHaveFetchPriority: true` | The browser-detected LCP `<img>` must have `fetchpriority="high"` |
| LCP srcset URLs return 200 | `lcpSrcsetShouldReturn200: true` | Every URL in the LCP image's `srcset` attribute must return HTTP 200 or 304. Skipped if the LCP element is not an `<img>` or has no `srcset`. |
| No broken images | always on | Any image that fails to load (`naturalWidth === 0`) is flagged |

> **LCP detection is automatic.** The test reads the real LCP element via `performance.getEntriesByType('largest-contentful-paint')` — no CSS selector configuration is needed. If the LCP element is not an `<img>` (e.g. a text node or background image), the LCP checks are skipped automatically.
>
> **Use `lcpImageNotLazy` instead of above-fold pixel thresholds.** The LCP check targets the element that actually matters for Core Web Vitals. Pixel-threshold approaches (`getBoundingClientRect()`) are unreliable because they run after the browser has already expanded the viewport — use `lcpImageNotLazy: true` instead.

**Example config:**
```json
"images": {
  "allImagesHaveAlt": { "enabled": true, "severity": "warning", "value": true },
  "allImagesHaveDimensions": { "enabled": true, "severity": "warning", "value": true },
  "lcpImageNotLazy": { "enabled": true, "severity": "warning", "value": true },
  "lcpImageShouldHaveFetchPriority": { "enabled": true, "severity": "warning", "value": true }
}
```

Use `"lcpImageShouldHaveFetchPriority": true` on templates where the hero image is the primary conversion element (e.g. product pages).

**Common failures:**
- Decorative images with `alt=""` — use `alt=" "` (space) for decorative images to differentiate from missing alt
- LCP image is lazy — add `loading="eager"` and `fetchpriority="high"` to your hero image

---

### linkHealth

**Config key:** `seo.linkHealth`

| Check | Field | Description |
|---|---|---|
| No empty hrefs | `noEmptyHrefs: true` | `<a href="">` and `<a href="#">` |
| No javascript hrefs | `noJavascriptHrefs: true` | `<a href="javascript:...">` |
| Internal links not nofollow | `internalLinksNoCrawlBlock: true` | Internal links must not have `rel="nofollow"` |
| External links have noopener | `externalLinksHaveNoopener: true` | External `target="_blank"` links must have `rel="noopener"` |
| No generic anchor text | `anchorTextBlocklist: ["click here"]` | Exact text blocklist (case-insensitive) |
| Specific links | `links` | Asserts that specific critical links are visible on the page |
| No broken internal links | `checkBrokenInternalLinks: true` | HEAD-requests all internal links; disabled by default |

---

### headingHierarchy

**Config key:** `seo.headingHierarchy`

| Check | Field | Description |
|---|---|---|
| No skipped levels | `noSkippedLevels: true` | No jump larger than 1 level (e.g. h1→h3 skipping h2) |
| No empty headings | `noEmptyHeadings: true` | All heading tags must have non-empty text content |

---

### renderingValidation
**Config key:** `seo.renderingValidation`

Typically gated to `lane: ["merge", "scheduled"]` because these checks require a real browser with network access.

| Check | Field | Description |
|---|---|---|
| No hidden SEO content | `noHiddenSeoContent: true` | `<h1>` and `<h2>` must not be hidden via CSS |
| No failed requests | `noFailedRequests: true` | No CSS, JS, font, or document requests fail |
| No mixed content | `noMixedContent: true` | No HTTP resources loaded on an HTTPS page |
| Block third-party | `blockThirdParty` | Array of glob-style patterns to block (e.g., `*google-analytics.com*`) |
| No vh trap | `noVhTrap: true` | After viewport expansion, no element should fill ≥ 90% of the expanded viewport height without a `max-height` cap |

**Common failures:**
- `noHiddenSeoContent` — hero heading hidden via large negative `text-indent` (cloaking signal)
- `noVhTrap` — a hero or full-screen section uses `height: 100vh` with no `max-height` cap; after Googlebot's single viewport expansion it recalculates to the new viewport height, causing the page to grow a second time. Googlebot doesn't re-expand, so content in that second-growth zone may not be rendered. Whether it's actually missed depends on JS lazy-loading and layout. Fix: add `max-height: 100svh` or a specific px cap.

---

### mobileUsability

**Config key:** `seo.mobileUsability`

Verifies that pages meet Google's mobile-first usability requirements. Runs against the Googlebot mobile viewport (412×732px, deviceScaleFactor 2.625) after Phase 2 expansion.

| Check | Field | Description |
|---|---|---|
| Tap target size | `minTapTargetSize: 48` | Interactive elements (`a`, `button`, `input`, `select`, `textarea`, `[role="button"]`, `[role="link"]`) must be at least this many px in both width and height. Invisible elements (0×0) are skipped. |
| Body text font size | `minFontSizePx: 12` | Visible text in `p`, `li`, `td`, `span`, `div` elements must have a computed font size ≥ this value in px. |

```json
"mobileUsability": {
  "minTapTargetSize": { "enabled": true, "severity": "warning", "value": 48 },
  "minFontSizePx": { "enabled": true, "severity": "warning", "value": 12 }
}
```

**Common failures:**
- Small tap targets — icon-only buttons or inline links without padding; add `min-width: 48px; min-height: 48px` or `padding` to increase touch area
- Font size below 12px — fine print, captions, or label text; Google flags this as a legibility issue for mobile users

---

### contentQuality

**Config key:** `seo.contentQuality`

```json
"contentQuality": {
  "minWordCount": { "enabled": true, "severity": "warning", "value": 100 }
}
```

Uses `document.body.innerText` (respects `display:none`) to count words. A page with fewer words than `minWordCount` is flagged as thin content.

**Common failures:**
- Low word count on what should be a content-rich page — likely a rendering failure (JS didn't execute, or content is in iframes)
- Legitimately thin pages (login page, 404 page) — set `minWordCount` lower or to `null` for those pages

---

### serverResponse

**Config key:** `seo.serverResponse`

Measures TTFB using `PerformanceNavigationTiming.finalResponseHeadersStart` (falling back to `responseStart`).

```json
"serverResponse": {
  "maxTTFB": { "enabled": true, "severity": "blocker", "value": 800 }
}
```

**Common failures:**
- TTFB > 800ms consistently — your origin server or database is slow; consider caching
- TTFB spikes on first request, then fast — cold-start behaviour (serverless functions, unwarmed caches)

---

### structuredData

**Config key:** `seo.structuredData`

Two main check groups:
1. **JSON-LD validation** — all blocks must be parseable; specific types and fields must match your `expected` list.
2. **Product price validation** — if you have `Product` schema, it asserts price > 0 and (optionally) that it's visible on the page.

| Check | Field / Severity | Description |
|---|---|---|
| Valid JSON-LD | always | All `<script type="application/ld+json">` must be parseable |
| Expected `@type` | `expected` | Asserts a block with the given `@type` exists |
| Required fields | `requiredFields` | Asserts specific keys (e.g. `offers`, `name`) exist |
| Field values | `expected` | Optional deep-comparison of keys and values |
| Product JSON-LD with offers | configured (default blocker) | If price check is enabled, a `Product` JSON-LD block with an `offers` object must exist |
| `offers.priceCurrency` | configured (default blocker) | ISO currency code (e.g. `"USD"`) must be set |
| `offers.price` > 0 | **always blocker** | Price must be a positive number. A zero price means a broken feed or misconfiguration. |
| Price visible in page body | `shouldBeVisibleOnPage` (warning) | If `true`, the JSON-LD price must appear in `document.body.innerText` (or within `priceSelector`). Always warning — prices legitimately change due to promotions. |

```json
"structuredData": {
  "expected": {
    "enabled": true,
    "severity": "blocker",
    "value": [
      { "@type": "WebSite", "name": "Site Name" },
      { "@type": "Product", "requiredFields": ["name", "offers"] }
    ]
  },
  "shouldBeVisibleOnPage": { "enabled": true, "severity": "warning", "value": true },
  "priceSelector": { "enabled": true, "severity": "warning", "value": ".product-price" }
}
```

**Common failures:**
- Invalid JSON — template rendering inserted an unescaped character
- Missing `@type` — the JSON-LD block exists but doesn't match the expected schema type
- `offers.price` is `0`, `null`, or a string like `"TBD"` — must be a positive number
- `offers.priceCurrency` missing — required for Google Shopping rich results
- Price not visible on page (warning) — JSON-LD price doesn't match what's displayed. Common causes: price updated in JSON-LD but not re-deployed, or formatting mismatch (JSON-LD has `"29.99"`, page shows `"$29.99"`). In the latter case, provide a `priceSelector` to narrow the search area, or set `shouldBeVisibleOnPage: false`.

---

### lazyContent

**Config key:** `seo.lazyContent`

Tests that `IntersectionObserver`-triggered content is visible after the two-phase viewport expansion. If the element doesn't appear, it means Googlebot won't see it.

```json
"lazyContent": {
  "selector": { "enabled": true, "severity": "blocker", "value": "[data-testid='lazy-section']" },
  "expectedText": { "enabled": true, "severity": "blocker", "value": "This content requires scrolling" }
}
```

Use this to explicitly test pages that use lazy-loading for content that matters for SEO (e.g., product descriptions loaded on scroll, FAQ sections).

---

## E2E checks

E2E checks run in the `e2e` Playwright project and don't render pages in a full browser (except for outbound link sampling). They use sitemap.xml as the source of truth.

### Sitemap: structure and validity

| Check | Description |
|---|---|
| Sitemap is fetchable and valid XML | `GET /sitemap.xml` must return parseable XML |
| URL count ≤ 50,000 | Google's sitemap URL limit |
| Every URL has a valid `<loc>` | Each `<loc>` must be a parseable absolute URL |

---

### Sitemap: noindex conflicts

Pages in `seo-checks.json` that have `metaRobots: "noindex, ..."` must not appear in the sitemap. Having a page in the sitemap tells Google to crawl it; having `noindex` tells it not to index it — these are contradictory signals.

---

### Sitemap: URL health

HEAD-requests up to `crawlConfig.maxUrls` sitemap URLs (random sample if more).

| Check | Description |
|---|---|
| All URLs return 2xx | No 4xx or 5xx responses (200 and 304 are considered healthy) |
| No sitemap URLs redirect | 301/302/307/308 in the sitemap means the sitemap is stale |
| No timeouts | All requests complete within `crawlConfig.timeoutMs` |

---

### Sitemap: coverage vs configured pages

Every page in `seo-checks.json` must appear in the sitemap. If a configured page is missing from the sitemap, it's at risk of de-indexing.

---

### Sitemap: outbound link sampling

Renders a sample of `crawlConfig.linkSampleSize` sitemap pages in a browser, extracts all internal links, and HEAD-requests them. Catches broken internal links across the site without a full crawl.

---

### Sitemap: redirect chains

For each sitemap URL that redirects, follows the redirect and checks if the destination also redirects. Chains of 3+ hops are flagged.

---

### Sitemap: hreflang clusters

For all pages in `seo-checks.json` that have `hreflang`, loads the rendered page and checks that hreflang references are **bidirectional**: if page A references page B in language `es`, page B must reference page A back.
n language `es`, page B must reference page A back.
ge B must reference page A back.
