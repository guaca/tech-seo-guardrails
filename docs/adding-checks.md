# Adding Custom Checks

This guide walks you through adding a new check end-to-end, using a worked example: verifying that a cookie consent banner is present on every page.

---

## Overview

A check has three parts:

1. **Config** — a key in `seo-checks.json` that declares the check and its severity
2. **Test code** — a conditional block in `seo-dom.spec.ts` that reads the config and runs the assertion
3. **Annotation** — a `test.info().annotations.push()` call that surfaces useful data in the HTML report

---

## Step 1: Add a config key to `seo-checks.json`

Add your new check to the `seo` block inside the relevant template. Follow the existing pattern: each check has a `severity` and then its specific options.

```json
"templates": {
  "default": {
    "seo": {
      ...
      "cookieConsent": {
        "selector": { "enabled": true, "severity": "blocker", "value": "#cookie-banner" },
        "mustBeVisible": { "enabled": true, "severity": "blocker", "value": true }
      }
    }
  }
}
```

Use `"blocker"` if a failing check should block the PR merge. Use `"warning"` if it should appear in the report but not block.

You can also add page-level overrides if some pages don't have a cookie banner:

```json
"pages": [
  {
    "path": "/legal/privacy",
    "template": "default",
    "seo": {
      "cookieConsent": null
    }
  }
]
```

Setting a check config to `null` skips it for that page.

---

## Step 2: Read the config in `seo-dom.spec.ts`

Open `tests/integration/seo-dom.spec.ts`. Inside the `for (const pageConfig of resolvedPages)` loop, add a new check block following the existing pattern:

```typescript
// ----------------------------------------------------------
// N. Cookie Consent Banner
// ----------------------------------------------------------

if (pageConfig.seo.cookieConsent) {
  const cc = pageConfig.seo.cookieConsent;

  if (cc.mustBeVisible && cc.mustBeVisible.enabled !== false) {
    const check = cc.mustBeVisible;
    const severity = getSeverity(check);

    test('[metadata] Cookie consent banner should be present and visible', async ({ page }) => {
      annotateSeverity(severity);

      const selector = cc.selector?.value || '#cookie-banner';
      const banner = page.locator(selector);
      const count = await banner.count();

      seoExpect(severity)(
        count,
        `Cookie consent banner not found at selector "${selector}". ` +
        `This may indicate the element is missing or blocked by another script.`,
      ).toBeGreaterThan(0);

      if (count > 0) {
        const isVisible = await banner.first().isVisible();
        seoExpect(severity)(
          isVisible,
          `Cookie consent banner exists at "${selector}" but is not visible.`,
        ).toBe(true);
      }
    });
  }
}
```

### Key helpers

All three helpers are imported at the top of `seo-dom.spec.ts`:

```typescript
import { seoExpect, annotateSeverity, getSeverity } from '../helpers/assertions';
```

| Helper | Purpose |
|---|---|
| `getSeverity(config)` | Reads the `severity` field from the check config object. Falls back to `"blocker"` if not set. |
| `annotateSeverity(severity)` | Pushes a `severity` annotation to the current test. The custom reporter uses this to group results in the SEO summary. |
| `seoExpect(severity)` | Returns `expect` (blocker) or `expect.soft` (warning) depending on severity. |

### Accessing page and request

The test callback receives `{ page }` (a Playwright `Page`) and optionally `{ request }` (a Playwright `APIRequestContext`) for HTTP-only checks:

```typescript
test('my check', async ({ page }) => {
  // DOM inspection
  const el = page.locator('selector');
  const text = await el.textContent();
});

test('my http check', async ({ request }) => {
  // HTTP-only, no browser
  const res = await request.get(`${seoConfig.baseUrl}/some-endpoint`);
  expect([200, 304].includes(res.status())).toBe(true);
});
```

### Using `page.evaluate()` for computed values

For checks that need computed CSS or DOM state that Playwright locators don't expose directly, use `page.evaluate()` to run code inside the browser:

```typescript
const bannerHeight = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? el.getBoundingClientRect().height : 0;
}, cc.selector?.value || '#cookie-banner');

seoExpect(severity)(bannerHeight, 'Cookie banner has zero height').toBeGreaterThan(0);
```

---

## Step 3: Annotate the result

Use `test.info().annotations.push()` to surface useful diagnostic data in the HTML report without affecting the test outcome. This is especially useful for numeric values.

```typescript
test.info().annotations.push({
  type: 'Cookie banner',
  description: `Found ${count} element(s) at "${cc.selector?.value || '#cookie-banner'}", visible: ${isVisible}`,
});
```

Annotations appear in the Playwright HTML report under each test's detail view. They're also useful for understanding values at the boundary of pass/fail thresholds (e.g. word count).

---

## Step 4: Annotate the test report tag

The test name starts with a category tag in square brackets — use this to make your check findable via `--grep`:

```
[metadata]   — page content, head tags, structured data, canonical, robots, links
[http]       — http status, robots.txt, canonical resolution
[rendering]  — JS rendering, TTFB, DOM, console errors
[content]    — word count, thin content
```

For the cookie consent banner example, `[metadata]` is appropriate since it's a head/DOM concern. Use `[rendering]` if the check involves computed styles or JS-triggered behaviour.

---

## Step 5: Test your new check

Run only the integration tests to iterate quickly:

```bash
TEST_BASE_URL=http://localhost:3000 npx playwright test --project=integration
```

Or filter to your specific check by grep:

```bash
npx playwright test --project=integration --grep "Cookie consent"
```

---

## Full worked example

### `seo-checks.json`

```json
"templates": {
  "default": {
    "seo": {
      "cookieConsent": {
        "severity": "blocker",
        "selector": "#cookie-banner",
        "mustBeVisible": true
      }
    }
  }
}
```

### `tests/integration/seo-dom.spec.ts` (new block, added before the closing `}`  of the `for` loop)

```typescript
// ----------------------------------------------------------
// Cookie Consent Banner
// ----------------------------------------------------------

if (pageConfig.seo.cookieConsent) {
  const cc = pageConfig.seo.cookieConsent;

  if (cc.mustBeVisible && cc.mustBeVisible.enabled !== false) {
    const check = cc.mustBeVisible;
    const severity = getSeverity(check);

    test('[metadata] Cookie consent banner should be present and visible', async ({ page }) => {
      annotateSeverity(severity);

      const selector = cc.selector?.value || '#cookie-banner';
      const banner = page.locator(selector);
      const count = await banner.count();

      test.info().annotations.push({
        type: 'Cookie banner',
        description: `Selector: "${selector}" | Found: ${count} element(s)`,
      });

      seoExpect(severity)(
        count,
        `Cookie consent banner not found at selector "${selector}".`,
      ).toBeGreaterThan(0);

      if (count > 0) {
        const isVisible = await banner.first().isVisible();
        seoExpect(severity)(
          isVisible,
          `Cookie consent banner found but not visible at "${selector}".`,
        ).toBe(true);
      }
    });
  }
}
```

---

## Adding an E2E check

For checks that don't require a browser (e.g. a custom HTTP header on all sitemap URLs), add them to `tests/e2e/seo-links.spec.ts` following the same pattern: `test.describe` block, use `checkUrlsBatch` or `request` directly, use `expect` or `expect.soft`.

E2E checks always run as blockers by convention since they catch site-wide issues.

---

## Adding a unit test for config validation

If your check config has required fields or validation rules (e.g. the selector must be a non-empty string), you can add a unit test in `tests/unit/seo-config.spec.ts`. Unit tests run without a browser and are fast — they're good for catching misconfigurations before CI even starts a browser session.
