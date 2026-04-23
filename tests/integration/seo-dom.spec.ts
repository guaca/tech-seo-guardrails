/**
 * Integration Tests: SEO DOM Checks
 *
 * Renders pages in a Googlebot-emulated browser and validates the DOM
 * against seo-checks.json expectations. Uses severity-aware assertions
 * so warnings don't block the build.
 *
 * This is the core of the SEO guardrail suite.
 */

import { test, expect, type Response, type Page, type BrowserContext } from '@playwright/test';
import { resolveConfig, samplePagesByTemplate } from '../../src/config-resolver';
import { checkUrlsBatch } from '../../src/sitemap-helper';
import { getRobots, GOOGLEBOT_UA } from '../../src/robots-helper';
import { setupInterceptors } from '../helpers/interceptors';
import { seoExpect, annotateSeverity, getSeverity } from '../helpers/assertions';
import { injectDeepQueryAll } from '../helpers/shadow-dom';
import { loadSeoConfig } from '../../src/load-config';

// Googlebot Smartphone context options — must match the integration project's `use` in playwright.config.js
const GOOGLEBOT_CONTEXT_OPTIONS = {
  userAgent: GOOGLEBOT_UA,
  viewport: { width: 412, height: 732 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

const seoConfig = loadSeoConfig();

const lane = process.env.SEO_LANE;
const resolvedPages = resolveConfig(seoConfig as any, lane);

// TEST_BASE_URL: where tests send requests (dev server, preview URL, staging).
// PROD_BASE_URL: the canonical production URL used for identity checks (canonical matching, link classification).
// Both fall back to seo-checks.json baseUrl if the env var is not set.
const testBaseUrl: string = process.env.TEST_BASE_URL || (seoConfig as any).baseUrl || 'http://localhost:3000';
const prodBaseUrl: string = process.env.PROD_BASE_URL || (seoConfig as any).baseUrl || testBaseUrl;

// SEO_CANONICAL_MODE controls how canonical URL checks behave:
//   'production' (default) — canonicals always point to the prod domain, even when testing on localhost.
//                            selfReferencingCanonical compares against prodBaseUrl + path.
//   'dynamic'              — canonicals reflect the current host (preview URL, staging, etc).
//                            selfReferencingCanonical compares against page.url().
const canonicalMode: string = process.env.SEO_CANONICAL_MODE || 'production';

// Page sampling: cap pages per template so large sites don't run exhaustive checks on every PR.
// Scheduled lane always runs all pages. Otherwise: SEO_SAMPLE_LIMIT > sampleConfig.maxPagesPerTemplate > (no cap).
const isScheduled = lane === 'scheduled';
const parsedEnvLimit = Number(process.env.SEO_SAMPLE_LIMIT);
const envSampleLimit = Number.isFinite(parsedEnvLimit) && parsedEnvLimit > 0 ? parsedEnvLimit : undefined;
const sampleLimit: number | undefined = isScheduled
  ? undefined
  : envSampleLimit ?? (seoConfig as any).sampleConfig?.maxPagesPerTemplate;
const sampledPages = sampleLimit ? samplePagesByTemplate(resolvedPages, sampleLimit) : resolvedPages;

// ============================================================
// Site-level checks (not per-page)
// ============================================================

test.describe('Site-level SEO checks', () => {
  test('page sampling summary', () => {
    const byTemplate = new Map<string, { total: number; sampled: number }>();
    for (const page of resolvedPages) {
      const key = page.template ?? '(unassigned)';
      if (!byTemplate.has(key)) byTemplate.set(key, { total: 0, sampled: 0 });
      byTemplate.get(key)!.total++;
    }
    for (const page of sampledPages) {
      const key = page.template ?? '(unassigned)';
      byTemplate.get(key)!.sampled++;
    }
    for (const [template, { total, sampled }] of byTemplate) {
      test.info().annotations.push({
        type: `Sampling: ${template}`,
        description: sampled === total
          ? `${sampled} pages (all)`
          : `${sampled} of ${total} pages sampled (limit: ${sampleLimit})`,
      });
    }
  });

  test('robots.txt should be accessible and contain Sitemap directive', async ({ request }) => {
    const response = await request.get(`${testBaseUrl}/robots.txt`);
    expect([200, 304].includes(response.status()), `robots.txt should return 200 or 304 (got ${response.status()})`).toBe(true);

    const body = await response.text();
    expect(body, 'robots.txt should contain a Sitemap directive').toContain('Sitemap:');
  });

  test('[metadata] page titles should be unique across all pages', () => {
    const titles = resolvedPages
      .map(p => ({ path: p.path, title: p.seo?.metadata?.title?.value as string | undefined }))
      .filter(p => p.title);

    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const { path, title } of titles) {
      if (seen.has(title!)) {
        duplicates.push(`"${title}" — used by ${seen.get(title!)} and ${path}`);
      } else {
        seen.set(title!, path);
      }
    }

    expect(duplicates, `Duplicate titles found:\n${duplicates.join('\n')}`).toHaveLength(0);
  });

  test('[metadata] meta descriptions should be unique across all pages', () => {
    const descriptions = resolvedPages
      .map(p => ({ path: p.path, desc: p.seo?.metadata?.metaDescription?.value as string | undefined }))
      .filter(p => p.desc);

    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const { path, desc } of descriptions) {
      if (seen.has(desc!)) {
        duplicates.push(`"${desc!.substring(0, 60)}…" — used by ${seen.get(desc!)} and ${path}`);
      } else {
        seen.set(desc!, path);
      }
    }

    expect(duplicates, `Duplicate meta descriptions found:\n${duplicates.join('\n')}`).toHaveLength(0);
  });
});

// ============================================================
// Per-page SEO checks
// ============================================================

for (const pageConfig of sampledPages) {
  test.describe(`SEO checks for: ${pageConfig.description} (${pageConfig.path})`, () => {
    // Default mode: all tests in this block run on the same worker, sharing the
    // single page load from beforeAll. Different pages still run in parallel
    // across workers. Using 'default' instead of 'serial' ensures tests do not skip if a previous test fails.
    test.describe.configure({ mode: 'default' });

    let httpResponse: Response | null;
    let interceptorResult: { blockedByRobotsTxt: string[]; blockedThirdParty: string[] };
    let failedRequests: string[] = [];
    let mixedContentUrls: string[] = [];
    // LCP data captured BEFORE viewport expansion to reflect what Google sees on initial render
    let lcpData: { loading: string | null; fetchPriority: string; src: string; srcset: string } | null = null;
    // Viewport phase data stored here so beforeEach can attach it as annotations on each test
    let viewportPhase1: { scrollHeight: number; bodyScrollHeight: number; innerHeight: number } | null = null;
    let viewportPhase2: { scrollHeight: number; innerHeight: number } | null = null;
    let viewportExpandedHeight = 0;
    // Shared page — created once in beforeAll, reused by all tests in this describe block.
    // fullyParallel: false on the integration project ensures a single worker, so beforeAll
    // runs once per describe block and `page` is consistent across all tests.
    let page: Page;
    let _context: BrowserContext;

    const enforceRobotsTxt = pageConfig.seo.httpChecks?.robotsTxtEnforcement?.enabled !== false && 
                             pageConfig.seo.httpChecks?.robotsTxtEnforcement?.value === true;
    const blockThirdParty = pageConfig.seo.renderingValidation?.blockThirdParty?.value ?? [];

    // Load the page once and reuse it across all tests in this describe block.
    test.beforeAll(async ({ browser }) => {
      // Page load + networkidle + viewport expansion can take longer than the per-test
      // timeout. Override for this hook only; individual tests keep the 10s default.
      test.setTimeout(60_000);
      _context = await browser.newContext({
        ...GOOGLEBOT_CONTEXT_OPTIONS,
        baseURL: testBaseUrl,
      });
      page = await _context.newPage();
      // Inject shadow DOM traversal helper before navigation.
      // Makes window.deepQueryAll(root, selector) available in all page.evaluate() calls.
      // On pages with no shadow DOM this behaves identically to querySelectorAll.
      await injectDeepQueryAll(page);

      // Collect failed network requests (CSS, JS, fonts — not images, handled separately)
      page.on('requestfailed', (req) => {
        const url = req.url();
        const resourceType = req.resourceType();
        if (['stylesheet', 'script', 'font', 'document'].includes(resourceType)) {
          failedRequests.push(`[${resourceType}] ${url}`);
        }
      });

      // Collect mixed content (HTTP resources loaded on an HTTPS page)
      page.on('request', (req) => {
        const pageUrl = req.frame()?.url() ?? '';
        if (pageUrl.startsWith('https://') && req.url().startsWith('http://')) {
          mixedContentUrls.push(`[${req.resourceType()}] ${req.url()}`);
        }
      });

      interceptorResult = await setupInterceptors(page, {
        baseUrl: testBaseUrl,
        enforceRobotsTxt,
        blockThirdParty,
      });

      httpResponse = await page.goto(pageConfig.path);

      // Wait for the page to reach the configured load state.
      // networkidle (default) — required for CSR, SSR+hydration, and any JS that modifies the DOM.
      // load — only for fully SSR sites where JavaScript never modifies content after the HTML loads.
      try {
        // networkidle can be brittle on pages with constant tracking/polling.
        // We give it a generous but bounded timeout so that if it fails,
        // we fall back gracefully rather than crashing the entire test suite.
        const waitTimeout = pageConfig.waitForReady === 'networkidle' ? 20_000 : undefined;
        await page.waitForLoadState(pageConfig.waitForReady as any, { timeout: waitTimeout });
      } catch (err) {
        if ((err as Error).message.includes('Timeout')) {
          console.warn(`[seo-dom] Warning: Page ${pageConfig.path} timed out waiting for ${pageConfig.waitForReady}. Proceeding with tests anyway.`);
        } else {
          throw err; // Re-throw real errors like navigation failures
        }
      }

      // ── Capture LCP BEFORE viewport expansion ──────────────────────────
      // LCP scores come from how real people see a site on their phones and screens, not from 
      // the artificial, oversized viewports Googlebot uses for crawling.
      // If we read LCP after expansion, a larger below-fold image could wrongly become the LCP element.
      lcpData = await page.evaluate(() => {
        return new Promise((resolve) => {
          const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const last = entries[entries.length - 1] as any;
            if (!last?.element || last.element.tagName !== 'IMG') {
              resolve(null);
            } else {
              const el = last.element as HTMLImageElement;
              resolve({
                loading: el.getAttribute('loading'),
                fetchPriority: el.fetchPriority,
                src: el.src.substring(0, 80),
                srcset: el.getAttribute('srcset') || '',
              });
            }
            observer.disconnect();
          });
          observer.observe({ type: 'largest-contentful-paint', buffered: true });

          // Fallback if no LCP is recorded within 5000ms
          setTimeout(() => {
            observer.disconnect();
            resolve(null);
          }, 5000);
        });
      });

      // ── Googlebot two-phase viewport expansion ──────────────────────────
      // Phase 1: measure full document height at standard mobile viewport (412×732)
      const phase1 = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        bodyScrollHeight: document.body.scrollHeight,
        innerHeight: window.innerHeight,
      }));
      viewportPhase1 = phase1;

      // Phase 2: expand viewport to full document height (mirrors Googlebot's expansion)
      viewportExpandedHeight = Math.max(phase1.scrollHeight, phase1.bodyScrollHeight);
      await page.setViewportSize({ width: 412, height: viewportExpandedHeight });

      // Wait one animation frame: vh units recalculate, IntersectionObservers fire
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

      viewportPhase2 = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      }));
    });

    // Attach viewport annotations to each test's report entry (no navigation — data already captured above).
    test.beforeEach(() => {
      if (viewportPhase1) {
        test.info().annotations.push({
          type: 'Viewport Phase 1 (412×732)',
          description:
            `innerHeight: ${viewportPhase1.innerHeight}px | ` +
            `scrollHeight: ${viewportPhase1.scrollHeight}px | ` +
            `body.scrollHeight: ${viewportPhase1.bodyScrollHeight}px`,
        });
        test.info().annotations.push({
          type: 'Viewport expansion',
          description: `412×${viewportPhase1.innerHeight}px → 412×${viewportExpandedHeight}px`,
        });
      }
      if (viewportPhase2) {
        test.info().annotations.push({
          type: 'Viewport Phase 2 (412×calculated)',
          description:
            `innerHeight: ${viewportPhase2.innerHeight}px | ` +
            `scrollHeight: ${viewportPhase2.scrollHeight}px` +
            (viewportPhase2.innerHeight >= viewportPhase2.scrollHeight ? ' ✓ stable' : ' ⚠ content grew after expansion'),
        });
      }
    });

    test.afterAll(async () => {
      await _context?.close();
    });

    // ── [crawlability] ────────────────────────────────────────
    // HTTP Response Checks ─────────────────────────────────────

    if (pageConfig.seo.httpChecks) {
      const http = pageConfig.seo.httpChecks;

      if (http.expectedStatusCode && http.expectedStatusCode.enabled !== false) {
        const check = http.expectedStatusCode;
        const severity = getSeverity(check);
        test('[http] should return expected status code', async () => {
          annotateSeverity(severity);
          const actualStatus = httpResponse!.status();
          const expectedStatus = check.value;
          if (expectedStatus === 200) {
            seoExpect(severity)(
              [200, 304].includes(actualStatus),
              `Expected status 200 or 304, got ${actualStatus}`
            ).toBe(true);
          } else {
            seoExpect(severity)(actualStatus, `Expected status ${expectedStatus}`).toBe(expectedStatus);
          }
        });
      }

      if (http.xRobotsTag && http.xRobotsTag.enabled !== false) {
        const check = http.xRobotsTag;
        const severity = getSeverity(check);
        test('[http] should not have unexpected X-Robots-Tag header', async () => {
          annotateSeverity(severity);
          const xRobotsTag = httpResponse!.headers()['x-robots-tag'];
          if (check.value === null) {
            seoExpect(severity)(xRobotsTag, 'X-Robots-Tag header should not be present').toBeUndefined();
          } else {
            seoExpect(severity)(xRobotsTag, `Expected X-Robots-Tag to be "${check.value}"`).toBe(check.value);
          }
        });
      }

      if (http.canonicalMustResolve && http.canonicalMustResolve.enabled !== false && pageConfig.seo.metadata?.canonical?.value) {
        const check = http.canonicalMustResolve;
        const severity = getSeverity(check);
        test('[http] canonical URL should resolve with HTTP 200 or 304', async ({ request }) => {
          annotateSeverity(severity);
          const canonicalUrl = pageConfig.seo.metadata.canonical.value;
          const response = await request.head(canonicalUrl);
          const status = response.status();
          seoExpect(severity)(
            [200, 304].includes(status),
            `Canonical "${canonicalUrl}" returned ${status} — a canonical pointing to a non-200/304 URL is worse than no canonical`,
          ).toBe(true);
        });
      }

      if (http.robotsTxtEnforcement && http.robotsTxtEnforcement.enabled !== false) {
        const check = http.robotsTxtEnforcement;
        const severity = getSeverity(check);
        test('[http] page URL must be allowed by robots.txt for Googlebot', async () => {
          annotateSeverity(severity);
          const robots = await getRobots(testBaseUrl);
          seoExpect(severity)(robots, 'robots.txt could not be fetched or parsed').not.toBeNull();

          const fullUrl = new URL(pageConfig.path, testBaseUrl).href;
          const allowed = robots!.isAllowed(fullUrl, GOOGLEBOT_UA);
          seoExpect(severity)(allowed, `${fullUrl} is BLOCKED by robots.txt`).toBe(true);
        });

        test('[http] no critical render resources (CSS/JS) blocked by robots.txt', async () => {
          annotateSeverity(severity);
          const blockedCritical = interceptorResult.blockedByRobotsTxt.filter((url) => {
            const lower = url.toLowerCase();
            return lower.endsWith('.css') || lower.endsWith('.js') ||
                   lower.includes('.css?') || lower.includes('.js?') ||
                   lower.includes('/css/') || lower.includes('/js/');
          });

          if (interceptorResult.blockedByRobotsTxt.length > 0) {
            test.info().annotations.push({
              type: 'robots.txt blocked resources',
              description: interceptorResult.blockedByRobotsTxt.join(', '),
            });
          }

          seoExpect(severity)(
            blockedCritical.length,
            `Blocked critical resources: ${blockedCritical.join(', ')}`,
          ).toBe(0);
        });
      }
    }

    // ── [metadata] ────────────────────────────────────────────
    // ----------------------------------------------------------
    // Core Metadata
    // ----------------------------------------------------------

    if (pageConfig.seo.metadata) {
      const meta = pageConfig.seo.metadata;

      if (meta.title && meta.title.enabled !== false) {
        const check = meta.title;
        const severity = getSeverity(check);
        test('[metadata] should have the correct <title>', async () => {
          annotateSeverity(severity);
          const title = await page.title();
          seoExpect(severity)(title, `Expected title to be "${check.value}"`).toBe(check.value);
        });
      }

      if (meta.h1 && meta.h1.enabled !== false) {
        const check = meta.h1;
        const severity = getSeverity(check);
        test('[metadata] should have the correct <h1>', async () => {
          annotateSeverity(severity);
          const results = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'h1').map((r: any) => ({
              text: (r.element.textContent || '').trim(),
              inShadow: r.inShadow,
              hostTag: r.hostTag,
            }))
          );
          if (results.some((r: any) => r.inShadow)) {
            test.info().annotations.push({
              type: 'Shadow DOM',
              description: `h1 found inside shadow root (host: ${results.find((r: any) => r.inShadow)?.hostTag})`,
            });
          }
          const texts = results.map((r: any) => r.text);
          // If no H1s exist, treat the "found text" as an empty string to allow matching an expected empty config
          const actualTexts = texts.length > 0 ? texts : [""];
          seoExpect(severity)(actualTexts, `Expected h1 to be "${check.value}"`).toContain(check.value);
        });
      }

      test('[metadata] should have exactly one <h1>', async () => {
        const severity = getSeverity(meta.h1);
        annotateSeverity(severity);
        const results = await page.evaluate(() =>
          (window as any).deepQueryAll(document, 'h1')
        );
        seoExpect(severity)(results.length, 'There should be exactly one <h1> on the page').toBe(1);
      });

      if (meta.h2s && meta.h2s.enabled !== false && Array.isArray(meta.h2s.value) && meta.h2s.value.length > 0) {
        const check = meta.h2s;
        const severity = getSeverity(check);
        test('[metadata] should have the expected <h2> elements', async () => {
          annotateSeverity(severity);
          const results = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'h2').map((r: any) => ({
              text: (r.element.textContent || '').trim(),
              inShadow: r.inShadow,
              hostTag: r.hostTag,
            }))
          );
          if (results.some((r: any) => r.inShadow)) {
            test.info().annotations.push({
              type: 'Shadow DOM',
              description: `h2(s) found inside shadow root (host: ${results.find((r: any) => r.inShadow)?.hostTag})`,
            });
          }
          const h2Texts = results.map((r: any) => r.text);
          for (const expectedH2 of check.value as string[]) {
            seoExpect(severity)(h2Texts, `Missing <h2> "${expectedH2}"`).toContain(expectedH2);
          }
        });
      }

      if (meta.canonical && meta.canonical.enabled !== false) {
        const check = meta.canonical;
        const severity = getSeverity(check);
        const resolveBase = canonicalMode === 'dynamic' ? testBaseUrl : prodBaseUrl;
        const expectedCanonical = new URL(check.value, resolveBase).href;
        // Normalize percent-encoding so that e.g. /caf%C3%A9 and /café compare equal.
        const normalize = (url: string | null) => url ? decodeURI(new URL(url).href) : url;

        test('[metadata] should have the correct canonical URL', async () => {
          annotateSeverity(severity);
          const canonical = await page.locator('link[rel="canonical"]').getAttribute('href', { timeout: 500 }).catch(() => null);
          seoExpect(severity)(normalize(canonical), `Expected canonical to be "${expectedCanonical}"`).toBe(normalize(expectedCanonical));
        });

        test('[metadata] Raw HTML canonical should not point to the wrong URL (Canonical Misdirection)', async ({ request }) => {
          annotateSeverity(severity);
          const response = await request.get(`${testBaseUrl}${pageConfig.path}`);
          const rawHtml = await response.text();
          
          const linkTags = rawHtml.match(/<link[^>]+>/ig) || [];
          const canonicalTag = linkTags.find(tag => /rel=["']canonical["']/i.test(tag));
          
          if (canonicalTag) {
            const hrefMatch = canonicalTag.match(/href=["']([^"']+)["']/i);
            if (hrefMatch) {
              const rawHref = hrefMatch[1];
              let resolvedRawHref: string | null = null;
              try {
                // Resolve against resolveBase to match expectedCanonical's resolution logic
                resolvedRawHref = new URL(rawHref, resolveBase).href;
              } catch {
                // Ignore invalid URLs
              }
              if (resolvedRawHref) {
                seoExpect(severity)(
                  normalize(resolvedRawHref),
                  `Found a canonical tag in raw HTML pointing to "${rawHref}". This is a Canonical Misdirection Trap — Googlebot may drop the page before JavaScript hydration fixes it to "${expectedCanonical}".`
                ).toBe(normalize(expectedCanonical));
              }
            }
          }
        });
      }

      if (meta.metaRobots && meta.metaRobots.enabled !== false) {
        const check = meta.metaRobots;
        const severity = getSeverity(check);
        test('[metadata] should have the correct meta robots', async () => {
          annotateSeverity(severity);
          const robots = await page.locator('meta[name="robots"]').getAttribute('content', { timeout: 500 }).catch(() => null);
          const expected = check.value || null;
          const actual = robots || null;
          seoExpect(severity)(actual, `Expected meta robots to be "${expected}"`).toBe(expected);
        });

        const expected = check.value || null;
        if (expected && !expected.includes('noindex')) {
          test('[metadata] Raw HTML should not contain a rogue noindex tag (Meta Robots Trap)', async ({ request }) => {
            annotateSeverity(severity);
            const response = await request.get(`${testBaseUrl}${pageConfig.path}`);
            const rawHtml = await response.text();
            
            const metaTags = rawHtml.match(/<meta[^>]+>/ig) || [];
            const hasNoindex = metaTags.some(tag => 
              /name=["']robots["']/i.test(tag) && /content=["'][^"']*noindex[^"']*["']/i.test(tag)
            );
            
            seoExpect(severity)(
              hasNoindex, 
              `Found a rogue "noindex" tag in the raw server HTML. This is a Meta Robots Trap — Googlebot may drop the page before JavaScript hydration fixes it to "${expected}".`
            ).toBe(false);
          });
        }
      }

      if (meta.maxCanonicalTags && meta.maxCanonicalTags.enabled !== false) {
        const check = meta.maxCanonicalTags;
        const severity = getSeverity(check);
        test('[metadata] should not have duplicate canonical tags', async () => {
          annotateSeverity(severity);
          const count = await page.locator('link[rel="canonical"]').count();
          seoExpect(severity)(count, `Found ${count} canonical tags`).toBeLessThanOrEqual(check.value);
        });
      }

      if (meta.maxRobotsTags && meta.maxRobotsTags.enabled !== false) {
        const check = meta.maxRobotsTags;
        const severity = getSeverity(check);
        test('[metadata] should not have duplicate meta robots tags', async () => {
          annotateSeverity(severity);
          const count = await page.locator('meta[name="robots"]').count();
          seoExpect(severity)(count, `Found ${count} robots tags`).toBeLessThanOrEqual(check.value);
        });
      }

      if (meta.selfReferencingCanonical && meta.selfReferencingCanonical.enabled !== false) {
        const check = meta.selfReferencingCanonical;
        const severity = getSeverity(check);
        test('[metadata] canonical should be self-referencing', async () => {
          annotateSeverity(severity);
          const canonical = await page.locator('link[rel="canonical"]').getAttribute('href', { timeout: 500 }).catch(() => null);
          const currentPageUrl = new URL(page.url());
          const expectedCanonical = canonicalMode === 'dynamic'
            ? page.url()
            : new URL(currentPageUrl.pathname + currentPageUrl.search, prodBaseUrl).href;
          seoExpect(severity)(canonical, `Canonical "${canonical}" does not match "${expectedCanonical}"`).toBe(expectedCanonical);
        });
      }

      if (meta.metaDescription && meta.metaDescription.enabled !== false) {
        const check = meta.metaDescription;
        const severity = getSeverity(check);
        test('[metadata] should have the correct meta description', async () => {
          annotateSeverity(severity);
          const description = await page.locator('meta[name="description"]').getAttribute('content', { timeout: 500 }).catch(() => null);
          const expected = check.value || null;
          const actual = description || null;
          seoExpect(severity)(actual, `Expected meta description to be "${expected}"`).toBe(expected);
        });
      }
    }

    // HTML Fundamentals ────────────────────────────────────────

    if (pageConfig.seo.htmlFundamentals) {
      const hf = pageConfig.seo.htmlFundamentals;

      if (hf.hasCharset && hf.hasCharset.enabled !== false) {
        const check = hf.hasCharset;
        const severity = getSeverity(check);
        test('[metadata] HTML: should have meta charset', async () => {
          annotateSeverity(severity);
          const count = await page.locator('meta[charset]').count();
          seoExpect(severity)(count, 'Missing <meta charset>').toBeGreaterThan(0);
        });
      }

      if (hf.hasViewport && hf.hasViewport.enabled !== false) {
        const check = hf.hasViewport;
        const severity = getSeverity(check);
        test('[metadata] HTML: should have meta viewport', async () => {
          annotateSeverity(severity);
          const count = await page.locator('meta[name="viewport"]').count();
          seoExpect(severity)(count, 'Missing <meta name="viewport">').toBeGreaterThan(0);
        });
      }

      if (hf.hasFavicon && hf.hasFavicon.enabled !== false) {
        const check = hf.hasFavicon;
        const severity = getSeverity(check);
        test('[metadata] HTML: should have a favicon', async () => {
          annotateSeverity(severity);
          const count = await page.locator('link[rel="icon"], link[rel="shortcut icon"]').count();
          seoExpect(severity)(count, 'Missing favicon').toBeGreaterThan(0);
        });
      }

      if (hf.maxTitleTags && hf.maxTitleTags.enabled !== false) {
        const check = hf.maxTitleTags;
        const severity = getSeverity(check);
        test('[metadata] HTML: should not have duplicate <title> tags', async () => {
          annotateSeverity(severity);
          const count = await page.locator('title').count();
          seoExpect(severity)(count, `Found ${count} <title> tags`).toBeLessThanOrEqual(check.value);
        });
      }
    }

    // Heading Hierarchy ────────────────────────────────────────

    if (pageConfig.seo.headingHierarchy) {
      const hh = pageConfig.seo.headingHierarchy;

      if (hh.noSkippedLevels && hh.noSkippedLevels.enabled !== false) {
        const check = hh.noSkippedLevels;
        const severity = getSeverity(check);
        test('[metadata] Headings: should not skip heading levels', async () => {
          annotateSeverity(severity);
          const results = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'h1, h2, h3, h4, h5, h6').map((r: any) => ({
              level: parseInt(r.element.tagName[1]),
              inShadow: r.inShadow,
              hostTag: r.hostTag,
            }))
          );
          const shadowCount = results.filter((r: any) => r.inShadow).length;
          if (shadowCount > 0) {
            test.info().annotations.push({
              type: 'Shadow DOM',
              description: `${shadowCount} of ${results.length} headings found inside shadow roots`,
            });
          }
          const levels = results.map((r: any) => r.level);
          for (let i = 1; i < levels.length; i++) {
            const jump = levels[i] - levels[i - 1];
            seoExpect(severity)(jump, `Heading skip: h${levels[i - 1]} → h${levels[i]}`).toBeLessThanOrEqual(1);
          }
        });
      }

      if (hh.noEmptyHeadings && hh.noEmptyHeadings.enabled !== false) {
        const check = hh.noEmptyHeadings;
        const severity = getSeverity(check);
        test('[metadata] Headings: should not have empty heading tags', async () => {
          annotateSeverity(severity);
          const emptyHeadings = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'h1, h2, h3, h4, h5, h6')
              .filter((r: any) => !(r.element.textContent || '').trim())
              .map((r: any) => r.element.tagName)
          );
          seoExpect(severity)(emptyHeadings).toHaveLength(0);
        });
      }
    }

    // Open Graph Tags ──────────────────────────────────────────

    if (pageConfig.seo.ogTags) {
      const ogConfig = pageConfig.seo.ogTags;
      const severity = getSeverity(ogConfig);
      const tags = ogConfig.tags?.value || ogConfig.tags || {};

      for (const [property, expectedContent] of Object.entries(tags)) {
        test(`[metadata] OG tag: ${property}`, async () => {
          annotateSeverity(severity);
          const content = await page.locator(`meta[property="${property}"]`).getAttribute('content', { timeout: 500 }).catch(() => null);
          const expected = property === 'og:url' || property === 'og:image'
            ? new URL(expectedContent as string, prodBaseUrl).href
            : expectedContent;
          seoExpect(severity)(content, `Expected ${property} to be "${expected}"`).toBe(expected);
        });
      }

      if (ogConfig.requireImage && ogConfig.requireImage.enabled !== false) {
        const check = ogConfig.requireImage;
        const checkSeverity = getSeverity(check);
        test('[metadata] OG: og:image should be present and return a valid image', async ({ request }) => {
          annotateSeverity(checkSeverity);
          const rawContent = await page.locator('meta[property="og:image"]').getAttribute('content', { timeout: 500 }).catch(() => null);
          seoExpect(checkSeverity)(
            rawContent,
            'og:image is missing. Social platforms require it to generate rich link previews.',
          ).not.toBeNull();

          if (rawContent) {
            // Internal images should be checked on the test server.
            // Absolute URLs pointing to production are allowed and checked on prod.
            const imageUrl = rawContent.startsWith('/') || rawContent.startsWith(new URL(prodBaseUrl).origin)
              ? new URL(rawContent.startsWith('/') ? rawContent : new URL(rawContent).pathname, testBaseUrl).href
              : new URL(rawContent, prodBaseUrl).href;

            const res = await request.head(imageUrl);
            const status = res.status();
            seoExpect(checkSeverity)(
              [200, 304].includes(status),
              `og:image URL returned ${status}: ${imageUrl}`,
            ).toBe(true);
            const contentType = res.headers()['content-type'] || '';
            seoExpect(checkSeverity)(
              contentType,
              `og:image Content-Type is not an image (got "${contentType}"): ${imageUrl}`,
            ).toContain('image/');
          }
        });
      }
    }

    // Twitter Card Meta Tags ───────────────────────────────────

    if (pageConfig.seo.twitterCards) {
      const tcConfig = pageConfig.seo.twitterCards;
      const severity = getSeverity(tcConfig);
      const tags = tcConfig.tags?.value || tcConfig.tags || {};

      for (const [name, expectedContent] of Object.entries(tags)) {
        test(`[metadata] Twitter Card: ${name}`, async () => {
          annotateSeverity(severity);
          const content = await page.locator(`meta[name="${name}"]`).getAttribute('content', { timeout: 500 }).catch(() => null);
          seoExpect(severity)(content, `Expected ${name} to be "${expectedContent}"`).toBe(expectedContent);
        });
      }
    }

    if (pageConfig.seo.metadata) {
      const meta = pageConfig.seo.metadata;

      if (meta.hreflang && meta.hreflang.enabled !== false && meta.hreflang.value) {
        const check = meta.hreflang;
        const severity = getSeverity(check);
        test('[metadata] should have correct hreflang tags', async () => {
          annotateSeverity(severity);
          const hreflangMap = check.value as Record<string, string>;
          for (const [lang, url] of Object.entries(hreflangMap)) {
            const href = await page.locator(`link[rel="alternate"][hreflang="${lang}"]`).getAttribute('href', { timeout: 500 }).catch(() => null);
            seoExpect(severity)(href, `Expected hreflang "${lang}" to point to "${url}"`).toBe(url);
          }
        });
      }
    }

    // ----------------------------------------------------------
    // Structured Data
    // ----------------------------------------------------------

    if (pageConfig.seo.structuredData) {
      const sdConfig = pageConfig.seo.structuredData;
      const severity = getSeverity(sdConfig);
      const expected = sdConfig.expected?.value || sdConfig.expected || [];

      test('[metadata] Structured Data: all JSON-LD should be valid JSON', async () => {
        annotateSeverity(severity);
        const results = await page.evaluate(() =>
          (window as any).deepQueryAll(document, 'script[type="application/ld+json"]')
            .map((r: any, i: number) => {
              try { JSON.parse(r.element.textContent || ''); return null; }
              catch (e) { return `Block ${i}: ${(e as Error).message}`; }
            })
            .filter(Boolean)
        );
        seoExpect(severity)(results, `Invalid JSON-LD: ${(results as string[]).join(', ')}`).toHaveLength(0);
      });

      if (Array.isArray(expected)) {
        expected.forEach((entry, i) => {
          test(`[metadata] Structured Data: block ${i + 1} with @type "${entry['@type']}"`, async () => {
            annotateSeverity(severity);
            const allJsonLd = await page.evaluate(() => {
              const scripts = (window as any).deepQueryAll(document, 'script[type="application/ld+json"]')
                .map((r: any) => r.element);
              const blocks: any[] = [];
              for (const script of scripts) {
                try {
                  const parsed = JSON.parse(script.textContent || '');
                  if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
                    blocks.push(...parsed['@graph']);
                  } else {
                    blocks.push(parsed);
                  }
                } catch {
                  continue;
                }
              }
              return blocks;
            });

            const match = allJsonLd.find((ld: any) => {
              if (!ld || !ld['@type']) return false;
              return Array.isArray(ld['@type']) ? ld['@type'].includes(entry['@type']) : ld['@type'] === entry['@type'];
            });
            seoExpect(severity)(match, `No JSON-LD found with @type "${entry['@type']}"`).toBeTruthy();
            if (!match) return;

            // Validate required fields: per-entry config takes precedence over defaults
            const DEFAULT_REQUIRED_FIELDS: Record<string, string[]> = {
              Product:       ['name', 'image', 'offers'],
              ProductGroup:  ['name', 'brand', 'hasVariant'],
              Article:       ['headline', 'author', 'datePublished'],
              BlogPosting:   ['headline', 'author', 'datePublished'],
              FAQPage:       ['mainEntity'],
              BreadcrumbList:['itemListElement'],
              Organization:  ['name', 'url'],
              WebSite:       ['name', 'url'],
              LocalBusiness: ['name', 'address'],
              Event:         ['name', 'startDate'],
              JobPosting:    ['title', 'hiringOrganization', 'jobLocation'],
            };
            const required: string[] = entry.requiredFields ?? DEFAULT_REQUIRED_FIELDS[entry['@type']] ?? [];
            for (const field of required) {
              seoExpect(severity)(
                (match as any)[field],
                `JSON-LD ${entry['@type']}: required field "${field}" is missing`,
              ).toBeTruthy();
            }

            // Compare configured expected fields — use subset matching so extra
            // fields in the actual JSON-LD (common in real-world markup) don't
            // cause false failures.
            for (const [key, value] of Object.entries(entry)) {
              if (key === '@type' || key === 'requiredFields') continue;
              if (value !== null && typeof value === 'object') {
                seoExpect(severity)(
                  (match as any)[key],
                  `JSON-LD ${entry['@type']}: "${key}" mismatch`,
                ).toMatchObject(value as any);
              } else {
                seoExpect(severity)(
                  (match as any)[key],
                  `JSON-LD ${entry['@type']}: "${key}" mismatch`,
                ).toEqual(value);
              }
            }
          });
        });
      }

      // --- Product Price Check (Moved from standalone category) ---
      if (sdConfig.shouldBeVisibleOnPage && sdConfig.shouldBeVisibleOnPage.enabled !== false) {
        test('[metadata] Structured Data: Product price valid and visible', async () => {
          annotateSeverity(severity);

          // Extract expected price from seo-checks.json — it's the source of truth.
          // For Product: offers.price. For ProductGroup: hasVariant[0].offers.price.
          const priceData = (() => {
            const entry = Array.isArray(expected) ? expected.find((e: any) => {
              const t = Array.isArray(e['@type']) ? e['@type'] : [e['@type']];
              return t.includes('Product') || t.includes('ProductGroup');
            }) : null;
            if (!entry) return null;

            const ldType = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']];
            if (ldType.includes('ProductGroup')) {
              const variant = Array.isArray(entry.hasVariant) ? entry.hasVariant[0] : null;
              const offer = variant && (Array.isArray(variant.offers) ? variant.offers[0] : variant.offers);
              if (!offer) return null;
              return { price: offer.price, priceCurrency: offer.priceCurrency ?? null };
            }

            const offer = Array.isArray(entry.offers) ? entry.offers[0] : entry.offers;
            if (!offer) return null;
            return { price: offer.price, priceCurrency: offer.priceCurrency ?? null };
          })();

          seoExpect(severity)(
            priceData,
            'No Product JSON-LD with an offers block found on this page',
          ).not.toBeNull();

          const price = Number(priceData!.price);
          seoExpect(severity)(
            isNaN(price) || price <= 0 ? null : price,
            `Product price "${priceData!.price}" is not a valid positive number`,
          ).not.toBeNull();

          seoExpect(severity)(
            priceData!.priceCurrency,
            'Product JSON-LD offers.priceCurrency is missing',
          ).not.toBeNull();

          if (sdConfig.shouldBeVisibleOnPage && sdConfig.shouldBeVisibleOnPage.enabled !== false) {
            const rawPrice: number = Number(priceData!.price);
            const priceVariants = [
              String(rawPrice),                                   // "9.99"
              rawPrice.toFixed(2),                               // "9.99"
              String(rawPrice).replace('.', ','),                 // "9,99"
              rawPrice.toFixed(2).replace('.', ','),              // "9,99"
              String(Math.floor(rawPrice)),                      // "9" (whole number display)
            ];

            const selector = sdConfig.priceSelector?.enabled !== false && sdConfig.priceSelector?.value ? sdConfig.priceSelector.value as string : null;
            let found = false;
            let contextMessage = '';

            const checkMatch = (text: string) => {
              const normalizedText = text.replace(/[^0-9.,]/g, ' ');
              return priceVariants.some((v) => {
                const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Ensure the price is not part of a larger number (prevent "1.99" matching in "11.99")
                const regex = new RegExp(`(?<!\\d)${escaped}(?!\\d)`);
                return regex.test(normalizedText);
              });
            };

            if (selector) {
              const elementsText = await page.evaluate((sel: string) => {
                return (window as any).deepQueryAll(document, sel)
                  .map((r: any) => r.element.innerText || r.element.textContent || '')
                  .join(' ');
              }, selector);
              found = checkMatch(elementsText);
              contextMessage = `in elements matching selector "${selector}"`;
            } else {
              const bodyText = await page.evaluate(() => document.body.innerText);
              found = checkMatch(bodyText);
              contextMessage = `in visible page text`;
            }

            seoExpect('warning')(
              found,
              `Price "${rawPrice}" from JSON-LD not found ${contextMessage} (tried: ${priceVariants.join(', ')}) — prices may differ due to promotions or formatting`,
            ).toBe(true);
          }
        });
      }
    }

    // ----------------------------------------------------------
    // Images
    // ----------------------------------------------------------

    if (pageConfig.seo.images) {
      const img = pageConfig.seo.images;

      if (img.allImagesHaveAlt && img.allImagesHaveAlt.enabled !== false) {
        const check = img.allImagesHaveAlt;
        const severity = getSeverity(check);
        test('[metadata] Images: all <img> should have alt attributes', async () => {
          annotateSeverity(severity);
          const images = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'img').map((r: any) => ({
              alt: r.element.getAttribute('alt'),
              src: (r.element.getAttribute('src') || '').substring(0, 60),
              inShadow: r.inShadow,
              hostTag: r.hostTag,
            }))
          );
          
          if (images.length === 0) return;
          
          const shadowCount = images.filter((r: any) => r.inShadow).length;
          if (shadowCount > 0) {
            test.info().annotations.push({
              type: 'Shadow DOM',
              description: `${shadowCount} of ${images.length} images found inside shadow roots`,
            });
          }
          for (const { alt, src } of images) {
            seoExpect(severity)(alt, `Image missing alt: ${src}`).not.toBeNull();
            seoExpect(severity)((alt || '').trim().length, `Image has empty alt: ${src}`).toBeGreaterThan(0);
          }
        });
      }

      if (img.allImagesHaveDimensions && img.allImagesHaveDimensions.enabled !== false) {
        const check = img.allImagesHaveDimensions;
        const severity = getSeverity(check);
        test('[metadata] Images: all <img> should have width and height', async () => {
          annotateSeverity(severity);
          const images = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'img').map((r: any) => ({
              width: r.element.getAttribute('width'),
              height: r.element.getAttribute('height'),
              src: (r.element.getAttribute('src') || '').substring(0, 60),
            }))
          );
          for (const { width, height, src } of images) {
            seoExpect(severity)(width, `Image missing width: ${src}`).not.toBeNull();
            seoExpect(severity)(height, `Image missing height: ${src}`).not.toBeNull();
          }
        });
      }

      if (img.lcpImageNotLazy && img.lcpImageNotLazy.enabled !== false) {
        const check = img.lcpImageNotLazy;
        const severity = getSeverity(check);
        test('[metadata] Images: LCP image should not be lazy loaded', async () => {
          annotateSeverity(severity);
          if (lcpData === null) {
            test.skip(true, 'LCP element is not an image tag — check skipped');
            return;
          }
          test.info().annotations.push({ type: 'LCP image', description: lcpData.src });
          seoExpect(severity)(
            lcpData.loading,
            `LCP image (${lcpData.src}) has loading="lazy"`,
          ).not.toBe('lazy');
          if (img.lcpImageShouldHaveFetchPriority && img.lcpImageShouldHaveFetchPriority.enabled !== false) {
            const fpCheck = img.lcpImageShouldHaveFetchPriority;
            const fpSeverity = getSeverity(fpCheck);
            seoExpect(fpSeverity)(
              lcpData.fetchPriority,
              `LCP image (${lcpData.src}) is missing fetchpriority="high"`,
            ).toBe('high');
          }
        });
      }

      test('[metadata] Images: no broken images on the page', async () => {
        const severity = getSeverity(img);
        annotateSeverity(severity);
        const brokenImages = await page.evaluate(() =>
          (window as any).deepQueryAll(document, 'img')
            .filter((r: any) => r.element.complete && r.element.naturalWidth === 0)
            .map((r: any) => r.element.src.substring(0, 80))
        );
        seoExpect(severity)(brokenImages, `Broken images: ${brokenImages.join(', ')}`).toHaveLength(0);
      });

      if (img.lcpSrcsetShouldReturn200 && img.lcpSrcsetShouldReturn200.enabled !== false) {
        const check = img.lcpSrcsetShouldReturn200;
        const severity = getSeverity(check);
        test('[metadata] Images: LCP image srcset URLs should all return 200 or 304', async ({ request }) => {
          annotateSeverity(severity);
          if (lcpData === null || !lcpData.srcset) {
            test.skip(true, 'LCP element is not an <img> or has no srcset — check skipped');
            return;
          }
          const srcsetUrls = await page.evaluate((srcset: string) => {
            return srcset
              .split(',')
              .map((s: string) => s.trim().split(/\s+/)[0])
              .filter((u: string) => u && !u.startsWith('data:'))
              .map((u: string) => new URL(u, document.baseURI).href);
          }, lcpData.srcset);

          for (const url of srcsetUrls) {
            const res = await request.head(url);
            const status = res.status();
            seoExpect(severity)(
              [200, 304].includes(status),
              `LCP srcset URL returned ${status}: ${url}`,
            ).toBe(true);
          }
        });
      }
    }

    // ----------------------------------------------------------
    // Link Health
    // ----------------------------------------------------------

    if (pageConfig.seo.linkHealth) {
      const lh = pageConfig.seo.linkHealth;

      if (lh.noEmptyHrefs && lh.noEmptyHrefs.enabled !== false) {
        const check = lh.noEmptyHrefs;
        const severity = getSeverity(check);
        test('[metadata] Links: should not have empty href attributes', async () => {
          annotateSeverity(severity);
          const emptyLinks = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'a').filter((r: any) => {
              const href = r.element.getAttribute('href') || '';
              return href === '' || href === '#';
            })
          );
          seoExpect(severity)(emptyLinks.length, `Found ${emptyLinks.length} links with empty or # href`).toBe(0);
        });
      }

      if (lh.noJavascriptHrefs && lh.noJavascriptHrefs.enabled !== false) {
        const check = lh.noJavascriptHrefs;
        const severity = getSeverity(check);
        test('[metadata] Links: should not have javascript: hrefs', async () => {
          annotateSeverity(severity);
          const jsLinks = await page.evaluate(() =>
            (window as any).deepQueryAll(document, 'a').filter((r: any) =>
              (r.element.getAttribute('href') || '').startsWith('javascript:')
            )
          );
          seoExpect(severity)(jsLinks.length, `Found ${jsLinks.length} links with javascript: href`).toBe(0);
        });
      }

      if (lh.internalLinksNoCrawlBlock && lh.internalLinksNoCrawlBlock.enabled !== false) {
        const check = lh.internalLinksNoCrawlBlock;
        const severity = getSeverity(check);
        test('[metadata] Links: internal links should not have rel="nofollow"', async () => {
          annotateSeverity(severity);
          const nofollowInternals = await page.evaluate((baseUrl) => {
            const origin = new URL(baseUrl).origin;
            return (window as any).deepQueryAll(document, 'a')
              .filter((r: any) => {
                const href = r.element.getAttribute('href') || '';
                const isInternal = href.startsWith('/') || href.startsWith(origin) || href.startsWith('//');
                const rel = (r.element.getAttribute('rel') || '').toLowerCase();
                return isInternal && rel.includes('nofollow');
              })
              .map((r: any) => `${r.element.getAttribute('href')} (rel="${r.element.getAttribute('rel')}")`);
          }, prodBaseUrl);
          seoExpect(severity)(nofollowInternals, `Internal links with nofollow: ${nofollowInternals.join(', ')}`).toHaveLength(0);
        });
      }

      if (lh.externalLinksHaveNoopener && lh.externalLinksHaveNoopener.enabled !== false) {
        const check = lh.externalLinksHaveNoopener;
        const severity = getSeverity(check);
        test('[metadata] Links: external target="_blank" should have rel="noopener"', async () => {
          annotateSeverity(severity);
          const unsafeExternals = await page.evaluate((baseUrl) => {
            const origin = new URL(baseUrl).origin;
            return (window as any).deepQueryAll(document, 'a[target="_blank"]')
              .filter((r: any) => {
                const href = r.element.getAttribute('href') || '';
                const isExternal = href.startsWith('http') && !href.startsWith(origin);
                const rel = (r.element.getAttribute('rel') || '').toLowerCase();
                return isExternal && !rel.includes('noopener');
              })
              .map((r: any) => r.element.getAttribute('href'));
          }, prodBaseUrl);
          seoExpect(severity)(unsafeExternals).toHaveLength(0);
        });
      }

      if (lh.anchorTextBlocklist?.enabled !== false && Array.isArray(lh.anchorTextBlocklist?.value) && lh.anchorTextBlocklist.value.length > 0) {
        const check = lh.anchorTextBlocklist;
        const severity = getSeverity(check);
        test('[metadata] Links: should not use generic anchor text', async () => {
          annotateSeverity(severity);
          const blocklist = (check.value as string[]).map((t: string) => t.toLowerCase());
          const genericLinks = await page.evaluate((bl: string[]) =>
            (window as any).deepQueryAll(document, 'a')
              .filter((r: any) => bl.includes((r.element.textContent || '').trim().toLowerCase()))
              .map((r: any) => `"${(r.element.textContent || '').trim()}" → ${r.element.getAttribute('href')}`)
          , blocklist);
          seoExpect(severity)(genericLinks).toHaveLength(0);
        });
      }

      if (lh.checkBrokenInternalLinks && lh.checkBrokenInternalLinks.enabled !== false) {
        const check = lh.checkBrokenInternalLinks;
        const severity = getSeverity(check);
        test('[metadata] Links: all internal links should resolve', async () => {
          annotateSeverity(severity);
          const internalHrefs = await page.evaluate(({ prodUrl, testUrl }) => {
            const prodOrigin = new URL(prodUrl).origin;
            const testOrigin = new URL(testUrl).origin;
            const pageProtocol = location.protocol;
            return [...new Set(
              (window as any).deepQueryAll(document, 'a')
                .map((r: any) => r.element.getAttribute('href') || '')
                .filter((href: string) =>
                  href.startsWith('/') ||
                  href.startsWith(prodOrigin) ||
                  href.startsWith('//')
                )
                .map((href: string) => {
                  if (href.startsWith('//')) return `${pageProtocol}${href}`;
                  if (href.startsWith('/')) return `${testOrigin}${href}`;
                  if (href.startsWith(prodOrigin)) return href.replace(prodOrigin, testOrigin);
                  return href;
                })
                .filter((href: string) => new URL(href).origin === testOrigin)
            )];
          }, { prodUrl: prodBaseUrl, testUrl: testBaseUrl });

          const results = await checkUrlsBatch(internalHrefs as string[], { concurrency: 10, method: 'HEAD' });
          const broken = results.filter((r) => !r.ok);
          for (const r of broken) {
            seoExpect(severity)(r.ok, `Broken link (not 200 or 304): ${r.url} → ${r.status ?? r.error}`).toBe(true);
          }
        });
      }

      if (lh.links && lh.links.enabled !== false && Array.isArray(lh.links.value) && lh.links.value.length > 0) {
        const check = lh.links;
        const severity = getSeverity(check);
        for (const link of check.value) {
          const label = link.expectedText || link.selector;
          test(`[metadata] should have link: "${label}"`, async () => {
            annotateSeverity(severity);
            let element;
            if (link.selector) {
              element = page.locator(link.selector).first();
            } else {
              element = page.getByRole('link', { name: link.expectedText, exact: true });
            }
            await expect(element).toBeVisible();
            if (link.selector && link.expectedText) {
              await expect(element).toHaveText(link.expectedText);
            }
          });
        }
      }
    }

    // ── [rendering] ───────────────────────────────────────────
    // ----------------------------------------------------------
    // Rendering Validation
    // ----------------------------------------------------------

    if (pageConfig.seo.renderingValidation) {
      const rv = pageConfig.seo.renderingValidation;

      if (rv.noHiddenSeoContent && rv.noHiddenSeoContent.enabled !== false) {
        const check = rv.noHiddenSeoContent;
        const severity = getSeverity(check);
        test('[rendering] SEO content should not be hidden by CSS', async () => {
          annotateSeverity(severity);
          const hiddenElements = await page.evaluate(() => {
            const hidden: string[] = [];
            const results = (window as any).deepQueryAll(document, 'h1');
            for (const { element: el, inShadow, hostTag } of results) {
              const cs = window.getComputedStyle(el);
              const reason: string[] = [];
              if (cs.display === 'none') reason.push('display:none');
              if (cs.visibility === 'hidden') reason.push('visibility:hidden');
              if (parseInt(cs.textIndent) < -999) reason.push(`text-indent:${cs.textIndent}`);
              if (cs.opacity === '0') reason.push('opacity:0');
              if (cs.clipPath && cs.clipPath !== 'none') reason.push(`clip-path:${cs.clipPath}`);
              if (cs.height === '0px' && (cs.overflow === 'hidden' || cs.overflow === 'clip')) {
                reason.push('height:0+overflow:hidden');
              }
              if (cs.position === 'absolute') {
                const left = parseInt(cs.left);
                const top = parseInt(cs.top);
                if (left < -9999 || top < -9999) reason.push(`off-screen(left:${cs.left},top:${cs.top})`);
              }
              if (reason.length > 0) {
                const location = inShadow ? ` [shadow:${hostTag}]` : '';
                hidden.push(`${el.tagName}${location}: "${(el.textContent || '').substring(0, 40)}" [${reason.join(', ')}]`);
              }
            }
            return hidden;
          });
          seoExpect(severity)(hiddenElements, `Hidden SEO content: ${hiddenElements.join('; ')}`).toHaveLength(0);
        });
      }

      if (rv.noVhTrap && rv.noVhTrap.enabled !== false) {
        const check = rv.noVhTrap;
        const severity = getSeverity(check);
        test('[rendering] no element should have unconstrained viewport-height sizing', async () => {
          annotateSeverity(severity);
          const trappedElements = await page.evaluate(() => {
            const skipTags = new Set(['html', 'body', 'script', 'style', 'head', 'noscript', 'meta', 'link']);
            const viewportHeight = window.innerHeight;
            const results: string[] = [];

            document.querySelectorAll('*').forEach((el) => {
              if (skipTags.has(el.tagName.toLowerCase())) return;
              const cs = window.getComputedStyle(el);
              if (cs.position === 'fixed' || cs.position === 'sticky') return;
              const height = el.getBoundingClientRect().height;
              if (height >= 500 && height / viewportHeight >= 0.9 && cs.maxHeight === 'none') {
                const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : '';
                const cls = el.classList[0] ? `.${el.classList[0]}` : '';
                const selector = `${el.tagName.toLowerCase()}${id}${cls}`;
                results.push(`${selector} height=${Math.round(height)}px (viewport=${viewportHeight}px, no max-height)`);
              }
            });

            return results;
          });
          seoExpect(severity)(
            trappedElements,
            `Elements with unconstrained vh-sizing detected — these may grow beyond Googlebot's single viewport expansion, potentially causing content to fall outside its rendering pass:\n  ${trappedElements.join('\n  ')}\n  Fix: add max-height to cap the element (e.g. max-height: 100svh).`,
          ).toHaveLength(0);
        });
      }

    }


    // ----------------------------------------------------------
    // Failed Network Requests
    // ----------------------------------------------------------

    if (pageConfig.seo.renderingValidation?.noFailedRequests && pageConfig.seo.renderingValidation.noFailedRequests.enabled !== false) {
      const check = pageConfig.seo.renderingValidation.noFailedRequests;
      const severity = getSeverity(check);

      test('[rendering] page should not have failed CSS/JS/font requests', async () => {
        annotateSeverity(severity);
        seoExpect(severity)(
          failedRequests,
          `Failed resource requests:\n${failedRequests.join('\n')}`,
        ).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------
    // Mixed Content
    // ----------------------------------------------------------

    if (pageConfig.seo.renderingValidation?.noMixedContent && pageConfig.seo.renderingValidation.noMixedContent.enabled !== false) {
      const check = pageConfig.seo.renderingValidation.noMixedContent;
      const severity = getSeverity(check);

      test('[rendering] HTTPS page should not load HTTP resources (mixed content)', async () => {
        annotateSeverity(severity);
        seoExpect(severity)(
          mixedContentUrls,
          `Mixed content detected — HTTP resources on HTTPS page:\n${mixedContentUrls.join('\n')}`,
        ).toHaveLength(0);
      });
    }

    // ----------------------------------------------------------
    // Server Response (TTFB)
    // ----------------------------------------------------------

    if (pageConfig.seo.serverResponse) {
      const sr = pageConfig.seo.serverResponse;

      if (sr.maxTTFB && sr.maxTTFB.enabled !== false) {
        const check = sr.maxTTFB;
        const severity = getSeverity(check);
        test('[rendering] Server Response: TTFB should be within threshold', async () => {
          annotateSeverity(severity);
          const ttfb = await page.evaluate(() => {
            const navEntry = performance.getEntriesByType('navigation')[0] as any;
            return Math.round(navEntry?.finalResponseHeadersStart ?? navEntry?.responseStart ?? 0);
          });
          test.info().annotations.push({ type: 'TTFB', description: `${ttfb}ms` });
          seoExpect(severity)(ttfb, `TTFB: ${ttfb}ms exceeds ${check.value}ms`).toBeLessThanOrEqual(check.value);
        });
      }
    }

    // ----------------------------------------------------------
    // Lazy Content
    // ----------------------------------------------------------

    if (pageConfig.seo.lazyContent) {
      const lazy = pageConfig.seo.lazyContent;
      
      // If lazyContent is enabled, it should have a selector
      if (lazy.selector && lazy.selector.enabled !== false) {
        const check = lazy.selector;
        const severity = getSeverity(check);
        test('[rendering] Lazy content should be visible in viewport', async () => {
          annotateSeverity(severity);
          
          const element = page.locator(check.value);
          const count = await element.count();
          const isViewportTest = pageConfig.path.includes('viewport-test');
          const errorMsg = isViewportTest
            ? `Lazy-loaded content not found at selector "${check.value}". Content that requires viewport proximity to trigger (IntersectionObserver-based lazy loading) may not render within Googlebot's expanded viewport.`
            : `Lazy-loaded content not found at selector "${check.value}"`;
          
          seoExpect(severity)(count, errorMsg).toBeGreaterThan(0);
          
          if (count > 0 && lazy.expectedText && lazy.expectedText.enabled !== false) {
            const textCheck = lazy.expectedText;
            const text = await element.textContent();
            seoExpect(getSeverity(textCheck))(text, 
              `Lazy content text mismatch. Expected to contain: "${textCheck.value}"`
            ).toContain(textCheck.value);
          }
        });
      }
    }

    // ----------------------------------------------------------
    // Mobile Usability
    // ----------------------------------------------------------

    if (pageConfig.seo.mobileUsability) {
      const mu = pageConfig.seo.mobileUsability;

      if (mu.minTapTargetSize && mu.minTapTargetSize.enabled !== false) {
        const check = mu.minTapTargetSize;
        const severity = getSeverity(check);
        const minSize = typeof check.value === 'number' ? check.value : 48;
        test(`[rendering] Mobile: tap targets should be at least ${minSize}px`, async () => {
          annotateSeverity(severity);
          const smallTargets = await page.evaluate((min: number) => {
            const interactives = (window as any).deepQueryAll(
              document, 'a, button, input, select, textarea, [role="button"], [role="link"]'
            ).map((r: any) => r.element);
            return (interactives as Element[])
              .filter((el: Element) => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                return rect.width < min || rect.height < min;
              })
              .map((el: Element) => {
                const rect = el.getBoundingClientRect();
                const label = el.getAttribute('aria-label') || el.textContent?.trim().substring(0, 30) || el.tagName;
                return `${el.tagName} "${label}" — ${Math.round(rect.width)}×${Math.round(rect.height)}px`;
              });
          }, minSize);
          test.info().annotations.push({
            type: 'Small tap targets',
            description: smallTargets.length === 0 ? 'None found' : smallTargets.slice(0, 5).join(' | '),
          });
          seoExpect(severity)(
            smallTargets,
            `Tap targets smaller than ${minSize}px (Google recommends ≥48px for mobile usability):\n${smallTargets.join('\n')}`,
          ).toHaveLength(0);
        });
      }

      if (mu.minFontSizePx && mu.minFontSizePx.enabled !== false) {
        const check = mu.minFontSizePx;
        const severity = getSeverity(check);
        const minPx = typeof check.value === 'number' ? check.value : 12;
        test(`[rendering] Mobile: body text font size should be at least ${minPx}px`, async () => {
          annotateSeverity(severity);
          const smallText = await page.evaluate((min: number) => {
            const els = (window as any).deepQueryAll(document, 'p, li, td, span, div')
              .map((r: any) => r.element) as Element[];
            return els
              .filter((el) => {
                if (!el.textContent?.trim()) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const fs = parseFloat(window.getComputedStyle(el).fontSize);
                return fs > 0 && fs < min;
              })
              .slice(0, 10)
              .map((el) => {
                const fs = window.getComputedStyle(el).fontSize;
                return `${el.tagName} "${el.textContent!.trim().substring(0, 30)}" — font-size: ${fs}`;
              });
          }, minPx);
          test.info().annotations.push({
            type: 'Small font sizes',
            description: smallText.length === 0 ? 'None found' : smallText.slice(0, 5).join(' | '),
          });
          seoExpect(severity)(
            smallText,
            `Text smaller than ${minPx}px found (legibility risk on mobile):\n${smallText.join('\n')}`,
          ).toHaveLength(0);
        });
      }
    }

    // ── [content] ─────────────────────────────────────────────
    // ----------------------------------------------------------
    // Content Quality
    // ----------------------------------------------------------

    if (pageConfig.seo.contentQuality) {
      const cq = pageConfig.seo.contentQuality;

      if (cq.minWordCount && cq.minWordCount.enabled !== false) {
        const check = cq.minWordCount;
        const severity = getSeverity(check);
        const minWords = check.value;

        test(`[content] page should have at least ${minWords} words of visible text`, async () => {
          annotateSeverity(severity);

          // body.innerText in Chromium already includes text from open shadow roots,
          // so no manual shadow DOM traversal is needed (it would double-count).
          const wordCount = await page.evaluate(() => {
            const text = (document.body as HTMLElement).innerText || '';
            return text.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
          });

          test.info().annotations.push({
            type: 'Word count',
            description: `${wordCount} words (minimum: ${minWords})`,
          });

          seoExpect(severity)(
            wordCount,
            `Thin content: only ${wordCount} words found (minimum: ${minWords}). ` +
            `This may indicate a rendering failure or genuinely low-quality page.`,
          ).toBeGreaterThanOrEqual(minWords);
        });
      }
    }

  });
}
