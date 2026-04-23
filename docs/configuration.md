# Configuration Reference: `seo-checks.json`

`seo-checks.json` is the contract that defines what your site should look like to Googlebot. Copy `seo-checks.example.json` to `seo-checks.json` and fill it in for your site. This file should **not** be committed to the framework repo (it contains site-specific metadata including page titles, canonical URLs, and expected structured data); add your own `.gitignore` entry if you fork this repo for your project.

---

## Top-level structure

```json
{
  "baseUrl": "https://your-site.com",
  "crawlConfig": { ... },
  "templates": { ... },
  "pages": [ ... ]
}
```

> **`baseUrl`** is your canonical production URL. It acts as the fallback for the `PROD_BASE_URL` environment variable — if `PROD_BASE_URL` is set, it takes precedence. To point tests at a different server (localhost, preview, staging), set `TEST_BASE_URL` rather than changing this value.

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | string | no* | The canonical production URL of the site. Used as the fallback for the `PROD_BASE_URL` environment variable. See note below. |
| `sampleConfig` | object | no | Controls page sampling per template. See `sampleConfig` section. |
| `crawlConfig` | object | no | Options for the sitemap-driven E2E checks. |
| `templates` | object | yes | Named template objects containing default SEO check configs. |
| `pages` | array | yes | List of pages to test. Each page references a template and can override any check setting. |

**\*`baseUrl` and environment variables**

`baseUrl` is the fallback for `PROD_BASE_URL`. If the `PROD_BASE_URL` environment variable is set, it takes precedence over this field. If neither is set, config validation fails.

The framework uses two URL variables at runtime:

- `PROD_BASE_URL` (or `baseUrl` fallback) — the canonical production URL: used for canonical tag matching and internal link classification. This value should never change between runs.
- `TEST_BASE_URL` — where tests actually send requests (localhost, preview URL, staging). Defaults to `PROD_BASE_URL` if not set.

Keep `baseUrl` in `seo-checks.json` as your production URL. Use `TEST_BASE_URL` to point tests at a different server without modifying the config file. See [docs/environments.md](./environments.md) for examples.

---

## `crawlConfig`

Controls the E2E sitemap crawl (`tests/e2e/seo-links.spec.ts`).

```json
"crawlConfig": {
  "sitemapUrl": "/sitemap.xml",
  "maxUrls": 500,
  "maxUrlsPerTemplate": 5,
  "concurrency": 10,
  "timeoutMs": 10000,
  "linkSampleSize": 5,
  "sitemapUrlsShouldNotRedirect": true,
  "retryAfterCapMs": 30000
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `sitemapUrl` | string | `/sitemap.xml` | Path (relative to `baseUrl`) where the sitemap is served. |
| `maxUrls` | number | `500` | Hard ceiling on total URLs checked. Acts as a secondary safety cap when per-template sampling is active. |
| `maxUrlsPerTemplate` | number | `5` | Maximum sitemap URLs to HEAD-request per page type (template). Requires `urlPattern` to be set on templates. Overridden by `SEO_SAMPLE_LIMIT` env var. |
| `concurrency` | number | `10` | Parallel HEAD requests when checking URL health. |
| `timeoutMs` | number | `10000` | Per-request timeout in milliseconds. |
| `linkSampleSize` | number | `5` | Number of pages to deep-crawl for outbound link verification. |
| `sitemapUrlsShouldNotRedirect` | boolean | `true` | Fail if any sitemap URL responds with a 3xx redirect. Redirects in sitemaps are an antipattern — they should always point to the canonical destination. |
| `retryAfterCapMs` | number | `30000` | Maximum milliseconds to wait when a URL returns HTTP 429 with a `Retry-After` header. Caps the wait so a misbehaving server cannot stall the crawl indefinitely. |

---

## `sampleConfig`

Controls how many pages are tested per template in the integration suite. Useful when a template has hundreds of pages (product listings, blog posts) and running all of them on every PR would be impractical.

```json
"sampleConfig": {
  "maxPagesPerTemplate": 50
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `maxPagesPerTemplate` | number | none (run all) | Maximum pages to test per template group. If a template has more pages than this, a random subset is selected on each run. |

**How sampling works:**

- Pages are grouped by their `template` field. Pages with no template are grouped together under `(unassigned)`.
- If a group has ≤ `maxPagesPerTemplate` pages, all are tested.
- If a group exceeds the limit, pages are shuffled randomly and only `maxPagesPerTemplate` are selected. The selection changes each run, so coverage rotates across the full page set over time.
- The `SEO_SAMPLE_LIMIT` environment variable overrides this value at runtime (useful in CI to adjust without editing the file).
- **The `weekly` lane always runs all pages regardless of this setting.**

A sampling summary is logged as a test annotation in the HTML report so you can see which templates were sampled and how many pages were selected vs. available.

---

## `templates`

Templates define the default SEO check configuration applied to all pages that reference them. You can have multiple templates and override individual settings per page.

The conventional template structure is:

| Template | `urlPattern` | What it covers |
|---|---|---|
| `home` | `^/$` | Homepage only — always its own template |
| `product` | `^/products/` | Repeating product pages |
| `category` | `^/collections/` | Repeating category/listing pages |
| `blog-post` | `^/blog/` | Repeating blog posts |
| `other` | `.*` | Standalone unique pages (`/about/`, `/contact/`, `/terms/`) |

`home` and `other` are added automatically by `npm run init-config`. You define the repeating page templates in between.

```json
"templates": {
  "home": {
    "urlPattern": "^/$",
    "waitForReady": "networkidle",
    "seo": {
      "metadata": {
        "title": { "enabled": true, "severity": "blocker", "value": "Home | Site Name" },
        "hasCharset": { "enabled": true, "severity": "warning", "value": true }
      }
    }
  },
  "product": {
    "urlPattern": "^/products/",
    "waitForReady": "networkidle",
    "seo": {
      "metadata": {
        "title": { "enabled": true, "severity": "blocker", "value": "Product Page" },
        "canonical": { "enabled": true, "severity": "blocker", "value": "/products/" },
        "maxCanonicalTags": { "enabled": true, "severity": "blocker", "value": 1 }
      }
    }
  }
}
```

### `urlPattern`

A regular expression matched against each sitemap URL's **pathname** to classify it into a template group for E2E per-template sampling. The first template whose `urlPattern` matches wins.

**Where `urlPattern` comes from:**

- **CSV generator users** (`npm run generate`): set automatically from `generator-config.json`. No manual action needed — patterns you define in the wizard are written to `seo-checks.json` for you.
- **Manual users**: add `urlPattern` to each template in `seo-checks.json` when you define your page types. Follow the convention above.

**How the E2E crawl uses it:**

When `urlPattern` is set on at least one template, the weekly E2E crawl groups all sitemap URLs by template and samples up to `crawlConfig.maxUrlsPerTemplate` (default: 5) per group randomly. URLs not matching any named template are grouped under `(other)` automatically. This ensures balanced coverage across page types regardless of how many product pages outnumber category pages in the sitemap.

If no template has a `urlPattern`, the E2E crawl falls back to a flat random sample capped at `crawlConfig.maxUrls`.

The catch-all `other` template (`urlPattern: ".*"`) is excluded from per-template URL sampling output — the E2E spec handles the unmatched group automatically.

### `waitForReady`

Before running checks, the test waits for the page to reach the configured load state. Set `waitForReady` to one of these string values, or omit it entirely — `"networkidle"` is the default and works for all sites.

`npm run setup` asks about this and sets it on all templates automatically.

| Value | When to use |
|---|---|
| `"networkidle"` **(default)** | Any site where JavaScript renders or modifies page content after load — including headings, body text, prices, images, meta tags, or structured data. This covers CSR, SSR+hydration, and frameworks like Next.js, Nuxt, SvelteKit, and React. Waits until no network activity for 500ms. |
| `"load"` | Sites where **all** page content — headings, body, prices, meta tags, JSON-LD — is in the raw server HTML response and JavaScript never modifies it. Waits for the `load` event (all resources downloaded). Slightly faster than `networkidle`. |

```json
// Most sites — omit waitForReady entirely, or be explicit:
"waitForReady": "networkidle"

// Fully SSR with no JS-driven content whatsoever:
"waitForReady": "load"
```

> **Note:** If your site has persistent WebSocket connections or continuous background polling, `networkidle` may time out or take much longer than expected. Use `"load"` in that case and set a shorter Playwright timeout.

---

## Check configs in `seo`

Every check in the `seo` object is an explicit object containing its own enablement and severity:

```json
"checkCategory": {
  "specificCheck": {
    "enabled": true,
    "severity": "blocker",
    "value": "expected value"
  }
}
```

The `severity` field defaults to `"blocker"` if omitted. Set it to `"warning"` if a failing check should be surfaced in the PR comment without blocking the merge.

### Severity levels

| Value | Behaviour |
|---|---|
| `"blocker"` | Uses a hard `expect()`. If the check fails, the test fails immediately and the PR merge is blocked. |
| `"warning"` | Uses `expect.soft()`. The check failure is recorded and included in the SEO summary report posted on the PR, but the merge is not blocked. |

### Disabling a check with `enabled: false`

Any check can be disabled without deleting its configuration:

```json
"structuredData": {
  "expected": {
    "enabled": false,
    "severity": "warning",
    "value": []
  }
}
```

When `"enabled": false` is present, the test for that specific check is skipped. Omitting the field or setting `"enabled": true` keeps the check active.

This applies to entire groups too if the group has an `enabled` field (like `structuredData` or `mobileUsability` in earlier versions, though now every check is granular).

#### Interactive check selection

Run `npm run configure` for a terminal checklist that shows all configured checks and lets you toggle them on or off. The script reads your configuration file and writes `"enabled": false` for anything you uncheck.

---

## Maintenance & Updates

Your site's SEO contract should evolve alongside your codebase. The framework separates your **Rules** from your **Page Data** to make maintenance easy.

### Rules vs. Data

-   **Rules (`generator-config.json`)**: These define *what* you test across entire page types. (e.g., "All products must have a title and a canonical").
-   **Page Data (`seo-checks.json`)**: This is the final contract that lists every page and its *expected values*. (e.g., "/products/shoes" should have title "Running Shoes").

### The Update Workflow

| If you want to... | Then... |
|---|---|
| **Change a severity** (e.g., Warning → Blocker) | 1. Run `npx seo-configure` and select `generator-config.json`<br>2. Run `npm run seo:generate` |
| **Enable a new check** (e.g., turn on JSON-LD) | 1. Run `npx seo-configure` and select `generator-config.json`<br>2. Run `npm run seo:generate` |
| **Update page metadata** (e.g., site redesign) | 1. Export a fresh CSV from Screaming Frog<br>2. Run `npm run seo:generate` |
| **Add new pages** | 1. Export a fresh CSV<br>2. Run `npm run seo:generate` |

> **Important:** If you use the CSV-driven workflow, **do not manually edit `seo-checks.json`**. Your manual changes will be lost the next time you regenerate from a CSV. Always update the rules in `generator-config.json` instead.

---

## `metadata`

Fundamental SEO signals and HTML structural tags.

```json
"metadata": {
  "title": { "enabled": true, "severity": "blocker", "value": "Page Title" },
  "h1": { "enabled": true, "severity": "blocker", "value": "Main Heading" },
  "h2s": { "enabled": true, "severity": "warning", "value": ["Subheading 1", "Subheading 2"] },
  "metaDescription": { "enabled": true, "severity": "warning", "value": "Description here." },
  "canonical": { "enabled": true, "severity": "blocker", "value": "/path" },
  "metaRobots": { "enabled": true, "severity": "blocker", "value": "index, follow" },
  "hreflang": { "enabled": true, "severity": "blocker", "value": { "en": "/" } },
  "hasCharset": { "enabled": true, "severity": "warning", "value": true },
  "hasViewport": { "enabled": true, "severity": "blocker", "value": true },
  "hasFavicon": { "enabled": true, "severity": "warning", "value": true },
  "maxTitleTags": { "enabled": true, "severity": "blocker", "value": 1 }
}
```

| Field | Type | Description |
|---|---|---|
| `title` | string | Expected `<title>` text. |
| `h1` | string | Expected `<h1>` text. |
| `h2s` | string[] | Expected `<h2>` texts (all must be present; order doesn't matter). |
| `metaDescription` | string | Expected meta description. |
| `canonical` | string | Expected canonical URL. Can be a relative path (`"/about"`) or an absolute URL. Relative paths are resolved against `PROD_BASE_URL` at runtime. |
| `metaRobots` | string | Expected `<meta name="robots" content="...">` value. |
| `hreflang` | object \| null | Hreflang map `{ "en": "https://...", "es": "https://..." }`. Set `null` to skip. |
| `hasCharset` | boolean | Assert `<meta charset>` is present. |
| `hasViewport` | boolean | Assert `<meta name="viewport">` is present. |
| `hasFavicon` | boolean | Assert a favicon link tag is present. |
| `maxTitleTags` | number | Maximum number of `<title>` tags allowed. Use `1`. |
| `maxCanonicalTags` | number | Maximum number of `<link rel="canonical">` tags allowed. Use `1`. Having duplicates confuses crawlers. |
| `maxRobotsTags` | number | Maximum number of `<meta name="robots">` tags allowed. Use `1`. |
| `selfReferencingCanonical` | boolean | Assert that the canonical URL matches the current page URL. |

---

## `httpChecks`

HTTP response checks. Run on every page via a HEAD/GET request.

```json
"httpChecks": {
  "enabled": true,
  "expectedStatusCode": { "enabled": true, "severity": "blocker", "value": 200 },
  "xRobotsTag": { "enabled": true, "severity": "blocker", "value": null },
  "maxRedirects": { "enabled": true, "severity": "warning", "value": 1 },
  "canonicalMustResolve": { "enabled": true, "severity": "blocker", "value": true },
  "robotsTxtEnforcement": { "enabled": true, "severity": "blocker", "value": true }
},

| Field | Type | Description |
|---|---|---|
| `expectedStatusCode` | number | Expected HTTP status code (usually 200 or 304). |
| `xRobotsTag` | `null` \| string | Set to `null` to assert the header must **not** be present. Set to a string (e.g. `"noindex"`) to assert the header's value. |
| `maxRedirects` | number | Maximum number of redirects before failing. Currently informational — wire into your assertions as needed. |
| `canonicalMustResolve` | boolean | Assert that the canonical URL (from the page-level `seo.canonical` field) returns HTTP 200 or 304. A canonical pointing to a 404 is worse than no canonical. |
| `robotsTxtEnforcement` | boolean | Assert that the page URL is allowed by `robots.txt` for Googlebot, and that no CSS/JS resources critical to rendering are blocked. |

---

## `images`

```json
"images": {
  "allImagesHaveAlt": { "enabled": true, "severity": "warning", "value": true },
  "allImagesHaveDimensions": { "enabled": true, "severity": "warning", "value": true },
  "lcpImageNotLazy": { "enabled": true, "severity": "warning", "value": true },
  "lcpImageShouldHaveFetchPriority": { "enabled": true, "severity": "warning", "value": true }
}
```

| Field | Type | Description |
|---|---|---|
| `allImagesHaveAlt` | boolean | Assert all `<img>` elements have a non-empty `alt` attribute. |
| `allImagesHaveDimensions` | boolean | Assert all `<img>` elements have explicit `width` and `height` attributes (prevents layout shift). |
| `lcpImageNotLazy` | boolean | Assert the LCP image does not have `loading="lazy"`. Use this instead of a pixel threshold — the browser identifies the actual LCP element automatically via the Performance API. |
| `lcpImageShouldHaveFetchPriority` | boolean | Assert the LCP image has `fetchpriority="high"`. No CSS selector needed — the browser identifies the LCP element automatically. |
| `lcpSrcsetShouldReturn200` | boolean | Assert that every URL listed in the LCP image's `srcset` attribute returns HTTP 200 or 304. Catches broken size variants (e.g. a 2x or 800w candidate that was deleted from the CDN). Skipped if the LCP element is not an `<img>` or has no `srcset`. Recommended for product and category templates. |

---

## `linkHealth`

```json
"linkHealth": {
  "noEmptyHrefs": { "enabled": true, "severity": "warning", "value": true },
  "noJavascriptHrefs": { "enabled": true, "severity": "warning", "value": true },
  "internalLinksNoCrawlBlock": { "enabled": true, "severity": "warning", "value": true },
  "externalLinksHaveNoopener": { "enabled": true, "severity": "warning", "value": true },
  "checkBrokenInternalLinks": { "enabled": false, "severity": "warning", "value": false },
  "anchorTextBlocklist": { "enabled": true, "severity": "warning", "value": ["click here"] }
}
```

| Field | Type | Description |
|---|---|---|
| `noEmptyHrefs` | boolean | Assert no links have `href=""` or `href="#"`. |
| `noJavascriptHrefs` | boolean | Assert no links have `href="javascript:..."`. |
| `internalLinksNoCrawlBlock` | boolean | Assert internal links do not have `rel="nofollow"`. |
| `externalLinksHaveNoopener` | boolean | Assert external links that open in a new tab (`target="_blank"`) have `rel="noopener"`. |
| `checkBrokenInternalLinks` | boolean | HEAD-request all internal links on the page and fail if any return 4xx/5xx. **Warning:** this can be slow on pages with many links. Disabled by default. |
| `anchorTextBlocklist` | string[] | Fail if any link uses one of these exact anchor text strings (case-insensitive). Use to catch vague text like `"click here"`, `"read more"`. |
| `links` | array | List of specific critical links that must be visible on the page. Each entry requires `expectedText` and/or `selector`. |

### Specific link entry format

Each entry in the `links.value` array needs at least one of `expectedText` or `selector` (both can be combined).

```json
"links": {
  "enabled": true,
  "severity": "blocker",
  "value": [
    { "expectedText": "About Us" },
    { "selector": ".footer a", "expectedText": "Privacy Policy" }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `expectedText` | one of the two | Finds the link by visible text using `getByRole('link', { name })`. Preferred: resilient to URL and class changes. |
| `selector` | one of the two | CSS selector — use when you need to scope to a container or the text alone is ambiguous. When both are set, `selector` locates the element and `expectedText` is also asserted on it. |

---

## `headingHierarchy`

```json
"headingHierarchy": {
  "noSkippedLevels": { "enabled": true, "severity": "warning", "value": true },
  "noEmptyHeadings": { "enabled": true, "severity": "warning", "value": true }
}
```

| Field | Type | Description |
|---|---|---|
| `noSkippedLevels` | boolean | Assert headings don't skip levels (e.g. `<h1>` → `<h3>` skipping `<h2>`). |
| `noEmptyHeadings` | boolean | Assert no heading tags have empty text content. |

---

## `renderingValidation`

Rendering checks verify how the page behaves once JavaScript executes. These are typically gated to merge and scheduled lanes because they require a deployed environment with real third-party scripts.

```json
"renderingValidation": {
  "noHiddenSeoContent": { "enabled": true, "severity": "blocker", "value": true },
  "noFailedRequests": { "enabled": true, "severity": "warning", "value": true },
  "noMixedContent": { "enabled": true, "severity": "blocker", "value": true },
  "blockThirdParty": { "enabled": true, "severity": "warning", "value": [] }
}
```

| Field | Type | Description |
|---|---|---|
| `lane` | string[] \| null | Restrict this check group to specific CI lanes. `["merge", "scheduled"]` means it only runs when `SEO_LANE=merge` or `SEO_LANE=scheduled`. Omit or set to `null` to run in all lanes. |
| `noHiddenSeoContent` | boolean | Assert that `<h1>` elements are not hidden via `display:none`, `visibility:hidden`, or large negative `text-indent` (a cloaking signal). |
| `noFailedRequests` | boolean | Fail if any CSS, JavaScript, font, or document request fails to load. |
| `noMixedContent` | boolean | Fail if any HTTP (non-HTTPS) resource is loaded on an HTTPS page. |
| `noVhTrap` | boolean | After viewport expansion, detect elements whose computed height fills ≥ 90% of the expanded viewport with no `max-height` cap. Elements using `height: 100vh` (or `svh`/`dvh`/`lvh`) without a cap recalculate to the full expanded height, potentially causing content to fall outside Googlebot's single rendering pass. `position: fixed` and `position: sticky` elements are excluded. |
| `blockThirdParty` | string[] | List of third-party domains to block during the test (e.g. `["analytics.example.com"]`). Useful for isolating first-party rendering issues. |

---

## `mobileUsability`

Mobile usability checks verify that pages meet Google's mobile-first requirements. These run against the Googlebot mobile viewport (412 × 732 px, deviceScaleFactor 2.625).

```json
"mobileUsability": {
  "minTapTargetSize": { "enabled": true, "severity": "warning", "value": 48 },
  "minFontSizePx": { "enabled": true, "severity": "warning", "value": 12 }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `minTapTargetSize` | number | `48` | Minimum dimension (px) for interactive elements (`a`, `button`, `[role="button"]`, `input`, `select`, `textarea`). Google recommends 48 × 48 px. Elements smaller than this can be difficult to tap on mobile. |
| `minFontSizePx` | number | `12` | Minimum computed font size (px) for text nodes. Google recommends 12 px or larger for body text legibility on mobile. |

> These checks use the Googlebot mobile viewport that is set for every integration test, so no additional page load is needed.

---

## `contentQuality`

```json
"contentQuality": {
  "minWordCount": { "enabled": true, "severity": "warning", "value": 100 }
}
```

| Field | Type | Description |
|---|---|---|
| `minWordCount` | number | Minimum number of visible words (`body.innerText` word count). Detects thin content or rendering failures where the page text doesn't load. |

---

## `serverResponse`

```json
"serverResponse": {
  "maxTTFB": { "enabled": true, "severity": "blocker", "value": 800 }
}
```

| Field | Type | Description |
|---|---|---|
| `maxTTFB` | number | Maximum Time to First Byte in milliseconds. Measured using the browser's `PerformanceNavigationTiming` API. Google uses TTFB as a signal for server health. |

---

## `ogTags`

```json
"ogTags": {
  "tags": {
    "enabled": true,
    "severity": "warning",
    "value": {
      "og:title": "Page Title | Site",
      "og:description": "Description here.",
      "og:type": "website",
      "og:url": "/"
    }
  },
  "requireImage": { "enabled": true, "severity": "warning", "value": true }
}
```

Set `requireImage: true` to additionally assert that `og:image` is present (required by most social platforms for rich link previews).

---

## `twitterCards`

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

## `structuredData`

```json
"structuredData": {
  "expected": {
    "enabled": true,
    "severity": "blocker",
    "value": [
      { "@type": "WebSite", "name": "Site Name" },
      { "@type": "Organization", "name": "Company Name" },
      { "@type": "Recipe", "requiredFields": ["name", "image", "recipeIngredient"] }
    ]
  },
  "shouldBeVisibleOnPage": { "enabled": true, "severity": "warning", "value": true },
  "priceSelector": { "enabled": true, "severity": "warning", "value": ".product-price" }
}
```

Each item in `expected.value` must match a JSON-LD block on the page. The `@type` is required and is used to find the matching block. Any other fields (except `requiredFields`) are deep-compared against the actual block — nested objects and arrays are compared by value (using `toEqual`), so a mismatch at any depth is surfaced.

**Required fields by `@type`:** for commonly used schema.org types the framework automatically validates that mandatory fields are present, regardless of what you specify in `expected`. You can override the default required fields for any entry using `requiredFields`:

| `@type` | Default required fields |
|---|---|
| `Product` | `name`, `image`, `offers` |
| `Article`, `BlogPosting` | `headline`, `author`, `datePublished` |
| `FAQPage` | `mainEntity` |
| `BreadcrumbList` | `itemListElement` |
| `Organization`, `WebSite` | `name`, `url` |
| `LocalBusiness` | `name`, `address` |
| `Event` | `name`, `startDate` |
| `JobPosting` | `title`, `hiringOrganization`, `jobLocation` |

For custom schema.org types not listed above, add a `requiredFields` array to the entry to define which fields must be present:

```json
{ "@type": "Recipe", "requiredFields": ["name", "image", "recipeIngredient"] }
```

A per-entry `requiredFields` always takes precedence over the defaults in the table above.

### Product Price Checks

If your page contains `Product` schema, the framework can additionally validate that the price is visible in the page text to catch rendering mismatches.

| Field | Type | Description |
|---|---|---|
| `shouldBeVisibleOnPage` | boolean | If `true` (default), asserts that the price value from JSON-LD appears somewhere in `document.body.innerText` (or within elements matching `priceSelector` if provided). Set to `false` to only validate structured data. |
| `priceSelector` | string | Optional CSS selector to narrow down where the framework looks for the price on the page. If omitted, it checks the entire visible body text. |

---

## `lazyContent`

---

## Template inheritance and per-page overrides

Settings in `pages[].seo` are **deep-merged** over the template settings. You only need to specify what differs from the template.

```json
"pages": [
  {
    "path": "/blog/my-post",
    "template": "blog-post",
    "description": "Blog post",
    "seo": {
      "metadata": {
        "title": { "enabled": true, "severity": "blocker", "value": "My Post | Blog" },
        "h1": { "enabled": true, "severity": "blocker", "value": "My Post" },
        "canonical": { "enabled": true, "severity": "blocker", "value": "/blog/my-post" },
        "metaRobots": { "enabled": true, "severity": "blocker", "value": "index, follow" },
        "metaDescription": { "enabled": true, "severity": "warning", "value": "A post about something useful." }
      },
      "contentQuality": {
        "minWordCount": { "enabled": true, "severity": "warning", "value": 500 }
      }
    }
  }
]
```

To skip a check for a specific page, set the check config to `null`:

```json
"seo": {
  "images": null
}
```

---

## Lane filtering

Any check group that has a `lane` array will only run when the `SEO_LANE` environment variable matches one of the values in the array.

```json
"renderingValidation": {
  "lane": ["merge", "scheduled"],
  ...
}
```

This lets you gate expensive or environment-sensitive checks (like console error monitoring) to your staging or scheduled CI jobs, without running them on every PR.

See [ci-integration.md](./ci-integration.md) for how lanes are set in GitHub Actions.
