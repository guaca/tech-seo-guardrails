/**
 * E2E Tests: Sitemap & Link Health
 *
 * Instead of crawling the entire site by following links (which can take hours
 * on large sites), we use the sitemap.xml as the source of truth:
 *
 * 1. Fetch & validate sitemap.xml structure
 * 2. HEAD-request every sitemap URL to check status codes (fast, no rendering)
 * 3. Flag sitemap URLs that redirect (a common SEO antipattern)
 * 4. Cross-check sitemap coverage against configured pages
 * 5. Sample a handful of pages for deep outbound link verification
 * 6. Check redirect chains and hreflang consistency
 *
 */

import { test, expect } from '@playwright/test';
import { resolveConfig } from '../../src/config-resolver';
import {
  fetchSitemap,
  checkUrlsBatch,
  followRedirectChain,
  sampleUrls,
  type SitemapValidation,
  type LinkCheckResult,
} from '../../src/sitemap-helper';
import { loadSeoConfig } from '../../src/load-config';

const seoConfig = loadSeoConfig();

const lane = process.env.SEO_LANE;
const resolvedPages = resolveConfig(seoConfig as any, lane);

// TEST_BASE_URL: where tests send requests (dev server, preview URL, staging).
// PROD_BASE_URL: the canonical production URL used for identity checks (internal link origin, hreflang normalization).
const testBaseUrl: string = process.env.TEST_BASE_URL || (seoConfig as any).baseUrl || 'http://localhost:3000';
const prodBaseUrl: string = process.env.PROD_BASE_URL || (seoConfig as any).baseUrl || testBaseUrl;

const crawl = (seoConfig as any).crawlConfig || {};
const sitemapPath: string = crawl.sitemapUrl || '/sitemap.xml';
const maxUrls: number = crawl.maxUrls || 500;
const maxUrlsPerTemplate: number =
  parseInt(process.env.SEO_SAMPLE_LIMIT || '', 10) ||
  crawl.maxUrlsPerTemplate ||
  20;
const concurrency: number = crawl.concurrency || 10;
const timeoutMs: number = crawl.timeoutMs || 10_000;
const linkSampleSize: number = crawl.linkSampleSize || 20;
const sitemapUrlsShouldNotRedirect: boolean = crawl.sitemapUrlsShouldNotRedirect ?? true;

let sitemap: SitemapValidation;

test.beforeAll(async () => {
  // E2E tests always run against the production environment.
  // Sitemap URLs are production URLs by definition — using testBaseUrl here
  // would cause all URL health checks to run against the wrong server.
  const sitemapUrl = new URL(sitemapPath, prodBaseUrl).href;
  sitemap = await fetchSitemap(sitemapUrl, 3, maxUrls);
});

// ─── Sitemap Validation ──────────────────────────────────────────────────────

test.describe('Sitemap: structure and validity', () => {
  test('sitemap.xml should be fetchable and valid XML', () => {
    expect(sitemap.isValid, `Sitemap errors: ${sitemap.errors.join(', ')}`).toBe(true);
  });

  test('sitemap should not exceed 50,000 URL limit', () => {
    expect(sitemap.urlCount).toBeLessThanOrEqual(50_000);
  });

  test('every sitemap URL should have a <loc> with a valid URL', () => {
    const invalid = sitemap.urls.filter((u) => {
      try {
        new URL(u.loc);
        return false;
      } catch {
        return true;
      }
    });
    expect(
      invalid,
      `Invalid URLs in sitemap:\n${invalid.map((u) => u.loc).join('\n')}`,
    ).toHaveLength(0);
  });

  test('sitemap should not contain duplicate URLs', () => {
    const locs = sitemap.urls.map((u) => u.loc);
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const loc of locs) {
      if (seen.has(loc)) dupes.add(loc);
      else seen.add(loc);
    }
    expect(
      [...dupes],
      `Duplicate URLs in sitemap (wastes crawl budget):\n${[...dupes].join('\n')}`,
    ).toHaveLength(0);
  });

  test('sitemap <lastmod> dates should be valid ISO 8601 and not in the future', () => {
    const now = Date.now();
    const invalid: string[] = [];
    const future: string[] = [];

    for (const u of sitemap.urls) {
      if (!u.lastmod) continue;
      const parsed = Date.parse(u.lastmod);
      if (isNaN(parsed)) {
        invalid.push(`${u.loc} — lastmod: "${u.lastmod}" is not valid ISO 8601`);
      } else if (parsed > now) {
        future.push(`${u.loc} — lastmod: "${u.lastmod}" is in the future`);
      }
    }

    expect.soft(invalid, `Invalid lastmod dates:\n${invalid.join('\n')}`).toHaveLength(0);
    expect.soft(future, `Future lastmod dates:\n${future.join('\n')}`).toHaveLength(0);
  });
});

// ─── Noindex ↔ Sitemap Conflict ──────────────────────────────────────────────

test.describe('Sitemap: noindex conflicts', () => {
  test('pages marked noindex should not appear in the sitemap', () => {
    const noindexPages = resolvedPages.filter((p) => {
      const robotsVal = (p.seo as any)?.metadata?.metaRobots;
      const robots = (typeof robotsVal === 'object' && robotsVal !== null) ? robotsVal.value : robotsVal;
      return typeof robots === 'string' && robots.toLowerCase().includes('noindex');
    });

    const sitemapLocs = new Set(sitemap.urls.map((u) => {
      try {
        return new URL(u.loc).pathname;
      } catch {
        return u.loc;
      }
    }));

    const conflicts = noindexPages.filter((p) => {
      const normalized = p.path.replace(/\/$/, '') || '/';
      return sitemapLocs.has(normalized) || sitemapLocs.has(normalized + '/');
    });

    expect(
      conflicts,
      `Pages with noindex found in sitemap (contradictory signals):\n` +
        conflicts.map((p) => {
          const robotsVal = (p.seo as any).metadata.metaRobots;
          const val = typeof robotsVal === 'object' ? robotsVal.value : robotsVal;
          return `  ${p.path} — metaRobots: "${val}"`;
        }).join('\n'),
    ).toHaveLength(0);
  });

  test('pages with X-Robots-Tag: noindex header should not appear in the sitemap', async ({ request }) => {
    // Check runtime X-Robots-Tag header for each configured page that is in the sitemap.
    // A page can signal noindex via HTTP header even if the config says "index" — both
    // are respected by Googlebot and both conflict with sitemap inclusion.
    const sitemapLocs = new Set(sitemap.urls.map((u) => new URL(u.loc).pathname));
    const conflicts: string[] = [];

    for (const pageConfig of resolvedPages) {
      const normalizedPath = pageConfig.path.replace(/\/$/, '') || '/';
      const inSitemap = sitemapLocs.has(normalizedPath) || sitemapLocs.has(normalizedPath + '/');
      if (!inSitemap) continue;

      const fullUrl = new URL(pageConfig.path, prodBaseUrl).href;
      try {
        const res = await request.head(fullUrl);
        const xRobotsTag = res.headers()['x-robots-tag'] ?? '';
        if (xRobotsTag.toLowerCase().includes('noindex')) {
          conflicts.push(`  ${pageConfig.path} — X-Robots-Tag: "${xRobotsTag}"`);
        }
      } catch {
        // Network errors are covered by URL health checks — skip silently here
      }
    }

    expect(
      conflicts,
      `Pages with X-Robots-Tag: noindex found in sitemap (contradictory signals):\n` +
        conflicts.join('\n'),
    ).toHaveLength(0);
  });
});

// ─── Sitemap URL Health (HEAD requests — fast) ───────────────────────────────

test.describe('Sitemap: URL health', () => {
  let urlsToCheck: string[];
  let results: LinkCheckResult[];

  test.beforeAll(async () => {
    const allLocs = sitemap.urls.map((u) => u.loc);

    // If templates define urlPattern, group sitemap URLs by page type and sample
    // each group at maxUrlsPerTemplate (overridden by SEO_SAMPLE_LIMIT env var).
    // Falls back to flat maxUrls cap if no urlPatterns are defined.
    const templates = (seoConfig as any).templates as Record<string, any> | undefined;
    const patterns = Object.entries(templates ?? {})
      .filter(([, t]) => typeof t.urlPattern === 'string')
      .map(([name, t]) => ({ name, re: new RegExp(t.urlPattern) }));

    if (patterns.length > 0) {
      const groups = new Map<string, string[]>();
      for (const { name } of patterns) groups.set(name, []);
      groups.set('(other)', []);

      for (const loc of allLocs) {
        const pathname = new URL(loc).pathname;
        const match = patterns.find(({ re }) => re.test(pathname));
        groups.get(match ? match.name : '(other)')!.push(loc);
      }

      const sampled: string[] = [];
      for (const [, group] of groups) {
        sampled.push(...sampleUrls(group, maxUrlsPerTemplate));
      }
      // Secondary safety cap (maxUrls is a hard ceiling regardless)
      urlsToCheck = sampled.length > maxUrls ? sampleUrls(sampled, maxUrls) : sampled;
    } else {
      // No urlPatterns defined — flat random cap across all sitemap URLs
      urlsToCheck = allLocs.length > maxUrls ? sampleUrls(allLocs, maxUrls) : allLocs;
    }

    results = await checkUrlsBatch(urlsToCheck, {
      concurrency,
      timeoutMs,
      method: 'HEAD',
    });
  });

  test('all sitemap URLs should return a successful status code', () => {
    const broken = results.filter(
      (r) => !r.ok || (r.status !== null && r.status >= 400),
    );
    expect(
      broken,
      `Broken URLs in sitemap:\n${broken.map((r) => `  ${r.url} → ${r.status ?? r.error}`).join('\n')}`,
    ).toHaveLength(0);
  });

  test('sitemap URLs should not redirect (301/302 in sitemap = antipattern)', () => {
    if (!sitemapUrlsShouldNotRedirect) {
      test.skip();
      return;
    }
    const redirects = results.filter(
      (r) => r.status !== null && [301, 302, 307, 308].includes(r.status),
    );
    expect(
      redirects,
      `Sitemap URLs that redirect (should be updated to final destination):\n${redirects.map((r) => `  ${r.url} → ${r.status} → ${r.redirectTarget || '?'}`).join('\n')}`,
    ).toHaveLength(0);
  });

  test('no sitemap URLs should time out', () => {
    const timedOut = results.filter((r) => r.error === 'Timeout');
    expect(
      timedOut,
      `URLs that timed out (>${timeoutMs}ms):\n${timedOut.map((r) => `  ${r.url}`).join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─── Sitemap Coverage ────────────────────────────────────────────────────────

test.describe('Sitemap: coverage vs configured pages', () => {
  test('every configured page should appear in the sitemap', () => {
    const sitemapLocs = new Set(
      sitemap.urls.map((u) => {
        try { return new URL(u.loc).pathname; } catch { return u.loc; }
      }),
    );

    const missing: string[] = [];
    for (const page of resolvedPages) {
      const normalizedPath = page.path.replace(/\/$/, '') || '/';
      const found = sitemapLocs.has(normalizedPath) || sitemapLocs.has(normalizedPath + '/');
      if (!found) {
        missing.push(page.path);
      }
    }

    expect(
      missing,
      `Configured pages NOT in sitemap (risk of de-indexing):\n${missing.map((p) => `  ${p}`).join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─── Deep Link Sampling (Playwright renders a few pages) ─────────────────────

test.describe('Sitemap: outbound link sampling', () => {
  test(`sample of ${linkSampleSize} pages should have no broken outbound links`, async ({ page, request }) => {
    const sitemapLocs = sitemap.urls.map((u) => u.loc);
    const sample = sampleUrls(sitemapLocs, linkSampleSize);
    const brokenLinks: string[] = [];

    for (const url of sample) {
      // Use 'load' to ensure all scripts (including deferred/module) have executed
      // before extracting links — required for CSR sites where links are JS-rendered.
      await page.goto(url, { waitUntil: 'load' });

      // Extract all internal links from the fully-rendered page
      const internalLinks = await page.evaluate((origin) => {
        return [...new Set(
          Array.from(document.querySelectorAll('a[href]'))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((href) => {
              try {
                return new URL(href).origin === new URL(origin).origin;
              } catch {
                return false;
              }
            })
        )];
      }, prodBaseUrl);

      // HEAD-check all internal links found on this page
      if (internalLinks.length > 0) {
        const linkResults = await checkUrlsBatch(internalLinks, {
          concurrency,
          timeoutMs,
          method: 'HEAD',
        });
        for (const r of linkResults) {
          if (!r.ok) {
            brokenLinks.push(`[${url}] → ${r.url} (${r.status ?? r.error})`);
          }
        }
      }
    }

    expect(
      brokenLinks,
      `Broken outbound links found on sampled pages:\n${brokenLinks.join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─── Redirect Chains ─────────────────────────────────────────────────────────

test.describe('Sitemap: redirect chains', () => {
  test('no redirect chains longer than 2 hops', async () => {
    const sitemapLocs = sitemap.urls.map((u) => u.loc);

    // First pass: find which sitemap URLs redirect at all
    const initialResults = await checkUrlsBatch(sitemapLocs, {
      concurrency,
      timeoutMs,
      method: 'HEAD',
    });

    const redirectingUrls = initialResults
      .filter((r) => r.redirectTarget)
      .map((r) => r.url);

    // Second pass: follow the full redirect chain only for URLs that redirect.
    // Google won't follow more than 3 hops, so maxHops=3 is the right limit.
    const chains: string[] = [];
    for (const url of redirectingUrls) {
      const { chain } = await followRedirectChain(url, { maxHops: 3, timeoutMs });
      if (chain.length > 2) {
        chains.push(chain.join(' → ') + ` (${chain.length - 1} hops)`);
      }
    }

    expect(
      chains,
      `Redirect chains found:\n${chains.join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─── Hreflang Consistency ────────────────────────────────────────────────────

test.describe('Sitemap: hreflang clusters', () => {
  test('hreflang references should be bidirectional', async ({ page }) => {
    const pagesWithHreflang: Array<{ url: string; langs: Record<string, string> }> = [];

    for (const pageConfig of resolvedPages) {
      if (!pageConfig.seo.metadata?.hreflang?.enabled) continue;

      await page.goto(pageConfig.path);
      const langs = await page.evaluate(() => {
        const map: Record<string, string> = {};
        document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => {
          const lang = el.getAttribute('hreflang');
          const href = el.getAttribute('href');
          if (lang && href) map[lang] = href;
        });
        return map;
      });

      if (Object.keys(langs).length > 0) {
        pagesWithHreflang.push({ url: pageConfig.path, langs });
      }
    }

    // Pre-build a URL → page map for O(1) lookups instead of O(n) per hreflang entry.
    const pagesByUrl = new Map<string, (typeof pagesWithHreflang)[number]>();
    for (const p of pagesWithHreflang) {
      pagesByUrl.set(new URL(p.url, prodBaseUrl).href, p);
    }

    for (const entry of pagesWithHreflang) {
      const entryHref = new URL(entry.url, prodBaseUrl).href;
      for (const [_lang, url] of Object.entries(entry.langs)) {
        const targetHref = new URL(url, prodBaseUrl).href;
        const peer = pagesByUrl.get(targetHref);
        expect.soft(
          peer,
          `hreflang: ${entry.url} references ${url} but that page is not in the contract — add it to seo-checks.json to verify bidirectionality`,
        ).toBeTruthy();
        if (peer) {
          const backRef = Object.values(peer.langs).find(
            (u) => new URL(u, prodBaseUrl).href === entryHref,
          );
          expect(
            backRef,
            `hreflang cluster broken: ${entry.url} references ${url} but not referenced back`,
          ).toBeTruthy();
        }
      }
    }
  });
});
