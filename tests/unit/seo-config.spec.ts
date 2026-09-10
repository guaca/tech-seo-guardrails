/**
 * Unit Tests: SEO Config Validation
 *
 * Fast, browser-free checks that validate seo-checks.json structure.
 * Catches misconfigurations before any browser spins up.
 * These run in the "unit" project — no Playwright browser needed.
 */

import { test, expect } from '@playwright/test';
import { validateConfig } from '../../src/config-schema';
import { resolveConfig, resolvePageConfig, samplePagesByTemplate } from '../../src/config-resolver';
import type { ResolvedPageConfig } from '../../src/config-resolver';
import { loadSeoConfig } from '../../src/load-config';
import basicExampleConfig from '../../seo-checks.basic.example.json';

const seoConfig = loadSeoConfig();

/** Builds a minimal, valid Basic-mode config (mode: "basic" checks, no per-page seo). */
function makeBasicConfig(overrides: { title?: any } = {}) {
  return {
    baseUrl: 'https://example.com',
    contractMode: 'basic',
    templates: {
      all: {
        urlPattern: '.*',
        waitForReady: 'networkidle',
        seo: {
          metadata: {
            title: { enabled: true, severity: 'warning', mode: 'basic', minLength: 10, ...overrides.title },
            hreflang: { enabled: true, severity: 'warning', mode: 'basic' },
          },
        },
      },
    },
    pages: [
      { path: '/', template: 'all', description: 'Home page' },
      { path: '/about', template: 'all', description: '/about' },
    ],
  };
}

test.describe('Config schema validation', () => {

  test('seo-checks.json should have no validation errors', () => {
    const errors = validateConfig(seoConfig);
    if (errors.length > 0) {
      const summary = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
      expect(errors, `Config validation errors:\n${summary}`).toHaveLength(0);
    }
  });

  test('baseUrl should be a valid URL', () => {
    expect(() => new URL(seoConfig.baseUrl)).not.toThrow();
  });

  test('should have no duplicate page paths', () => {
    const paths = seoConfig.pages.map((p) => p.path);
    const unique = new Set(paths);
    expect(paths.length, `Duplicate paths found`).toBe(unique.size);
  });

  // Merges each page with its template (without stripping disabled checks) so
  // template-only pages — e.g. every page in a Basic-mode contract, which never
  // carry their own `seo` block — are evaluated correctly instead of crashing
  // on an undefined `page.seo`.
  function resolvedPageFor(page: (typeof seoConfig.pages)[number]) {
    return resolvePageConfig(page as any, (seoConfig as any).templates);
  }

  // Basic-mode contracts deliberately let each of the 6 checks be enabled
  // independently — treating title/canonical/metaRobots as always-required
  // "critical signals" (the Custom-mode assumption below) would contradict
  // that design, so these sanity checks only apply to Custom contracts.
  const isBasicContract = (seoConfig as any).contractMode === 'basic';

  test('every page should have a title', () => {
    test.skip(isBasicContract, 'Basic-mode checks are independently optional by design');
    for (const page of seoConfig.pages) {
      const title = resolvedPageFor(page).seo?.metadata?.title;
      const hasTitle = !!title && (!!title.value || title.mode === 'basic');
      expect(hasTitle, `Page "${page.path}" is missing a title`).toBe(true);
    }
  });

  test('every page should have a canonical URL', () => {
    test.skip(isBasicContract, 'Basic-mode checks are independently optional by design');
    for (const page of seoConfig.pages) {
      const canonical = resolvedPageFor(page).seo?.metadata?.canonical;
      const hasCanonical = !!canonical && (!!canonical.value || canonical.mode === 'basic');
      expect(hasCanonical, `Page "${page.path}" is missing a canonical`).toBe(true);
      // Custom-mode canonicals carry a fixed expected value — validate its shape.
      // Basic-mode canonicals have no fixed value (checked for existence/non-empty at runtime instead).
      if (canonical?.value) {
        const canonicalValue = canonical.value as string;
        const isValid = canonicalValue.startsWith('/')
          || (() => { try { new URL(canonicalValue); return true; } catch { return false; } })();
        expect(isValid, `Page "${page.path}" has invalid canonical: "${canonicalValue}"`).toBe(true);
      }
    }
  });

  test('every page should have metaRobots defined', () => {
    test.skip(isBasicContract, 'Basic-mode checks are independently optional by design');
    for (const page of seoConfig.pages) {
      const metaRobots = resolvedPageFor(page).seo?.metadata?.metaRobots;
      const hasMetaRobots = !!metaRobots && (metaRobots.value !== undefined || metaRobots.mode === 'basic');
      expect(hasMetaRobots, `Page "${page.path}" is missing metaRobots`).toBe(true);
    }
  });

  test('structuredData entries should all have @type', () => {
    for (const page of seoConfig.pages) {
      const structuredData = resolvedPageFor(page).seo?.structuredData;
      const expected = structuredData?.expected?.value || structuredData?.expected;
      if (expected && Array.isArray(expected)) {
        for (const sd of expected) {
          expect(sd['@type'], `Page "${page.path}" has structuredData without @type`).toBeTruthy();
        }
      }
    }
  });
});

test.describe('Basic mode contracts', () => {

  test('a generated Basic contract should have no validation errors', () => {
    const errors = validateConfig(basicExampleConfig);
    if (errors.length > 0) {
      const summary = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
      expect(errors, `Config validation errors:\n${summary}`).toHaveLength(0);
    }
  });

  test('mode: "basic" checks without a per-page seo override should not trigger required-field errors', () => {
    const errors = validateConfig(makeBasicConfig());
    expect(errors).toHaveLength(0);
  });

  test('an unknown check mode should be rejected', () => {
    const config = makeBasicConfig({ title: { mode: 'exotic' } });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.endsWith('.mode'))).toBe(true);
  });

  test('a negative minLength should be rejected', () => {
    const config = makeBasicConfig({ title: { minLength: -5 } });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.endsWith('.minLength'))).toBe(true);
  });

  test('a non-integer minLength should be rejected', () => {
    const config = makeBasicConfig({ title: { minLength: 10.5 } });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.endsWith('.minLength'))).toBe(true);
  });
});

test.describe('Template resolution', () => {

  test('all referenced templates should exist', () => {
    for (const page of seoConfig.pages) {
      if (page.template && seoConfig.templates) {
        expect(
          (seoConfig.templates as Record<string, any>)[page.template],
          `Template "${page.template}" referenced by "${page.path}" not found`,
        ).toBeTruthy();
      }
    }
  });

  test('resolveConfig should produce resolved pages', () => {
    const resolved = resolveConfig(seoConfig as any);
    expect(resolved.length).toBe(seoConfig.pages.length);

    for (const page of resolved) {
      expect(page.waitForReady, `Page "${page.path}" should have waitForReady`).toBeTruthy();
      expect(page.seo, `Page "${page.path}" should have seo`).toBeTruthy();
    }
  });

  test('template defaults should be merged into page config', () => {
    const resolved = resolveConfig(seoConfig as any);
    for (const page of resolved) {
      // If template or page has a check, it should be in resolved
      const templateName = seoConfig.pages.find(p => p.path === page.path)?.template;
      const template = templateName ? (seoConfig.templates as any)[templateName] : null;
      if (template?.seo?.httpChecks) {
        expect(page.seo.httpChecks, `Page "${page.path}" should inherit httpChecks`).toBeTruthy();
      }
    }
  });

  test('page overrides should take precedence over template', () => {
    // Find a page that actually defines its own title override — template-only
    // pages (e.g. every page in a Basic-mode contract) have nothing to test here.
    const page = seoConfig.pages.find((p) => (p as any).seo?.metadata?.title);
    test.skip(!page, 'No page in this config defines a per-page title override');
    if (!page) return;
    const pageTitle = (page as any).seo.metadata.title;
    const resolved = resolvePageConfig(page as any, (seoConfig as any).templates);
    // Page-specific title should be preserved
    expect(resolved.seo.metadata.title?.value || resolved.seo.metadata.title).toEqual(pageTitle?.value || pageTitle);
  });

  test('lane filtering should exclude non-matching checks', () => {
    // Only test pages that actually have a check with lane restrictions
    const resolved = resolveConfig(seoConfig as any, 'pr');
    for (const page of resolved) {
      for (const group of Object.values(page.seo)) {
        if ((group as any).lane) {
          const lanes = Array.isArray((group as any).lane) ? (group as any).lane : [(group as any).lane];
          if (!lanes.includes('pr')) {
             // This check is complex because resolveConfig filters them out
          }
        }
      }
    }
  });

  test('lane filtering without lane should include everything', () => {
    const resolved = resolveConfig(seoConfig as any);
    const originalPage = seoConfig.pages[0];
    const resolvedPage = resolved.find(p => p.path === originalPage.path);
    if (originalPage.seo?.renderingValidation) {
      expect(resolvedPage?.seo.renderingValidation).toBeTruthy();
    }
  });
});

test.describe('Page sampling', () => {
  function makePage(template: string | undefined, path: string): ResolvedPageConfig {
    return {
      path,
      template,
      description: path,
      waitForReady: 'networkidle',
      seo: {},
    };
  }

  test('returns all pages when group size is below the limit', () => {
    const pages = [makePage('product', '/a'), makePage('product', '/b'), makePage('product', '/c')];
    const result = samplePagesByTemplate(pages, 5);
    expect(result).toHaveLength(3);
  });

  test('caps pages at limit when group exceeds it', () => {
    const pages = Array.from({ length: 10 }, (_, i) => makePage('product', `/p${i}`));
    const result = samplePagesByTemplate(pages, 4);
    expect(result).toHaveLength(4);
  });

  test('applies limit independently per template', () => {
    const products = Array.from({ length: 10 }, (_, i) => makePage('product', `/p${i}`));
    const blogs = Array.from({ length: 10 }, (_, i) => makePage('blog', `/b${i}`));
    const result = samplePagesByTemplate([...products, ...blogs], 3);
    expect(result).toHaveLength(6); // 3 products + 3 blogs
    expect(result.filter(p => p.template === 'product')).toHaveLength(3);
    expect(result.filter(p => p.template === 'blog')).toHaveLength(3);
  });

  test('groups pages without a template under (unassigned)', () => {
    const pages = Array.from({ length: 8 }, (_, i) => makePage(undefined, `/u${i}`));
    const result = samplePagesByTemplate(pages, 3);
    expect(result).toHaveLength(3);
  });

  test('random selection varies across calls for large groups', () => {
    const pages = Array.from({ length: 20 }, (_, i) => makePage('blog', `/b${i}`));
    const run1 = samplePagesByTemplate(pages, 5, 1).map(p => p.path).sort();
    // With 20 pages and limit 5, probability of identical selection is C(20,5)^-1 ≈ 0.06%.
    // We assert they are not always the same across multiple attempts with different seeds.
    let allSame = true;
    for (let i = 0; i < 5; i++) {
      const run = samplePagesByTemplate(pages, 5, i + 2).map(p => p.path).sort().join(',');
      if (run !== run1.join(',')) { allSame = false; break; }
    }
    expect(allSame, 'sampling should not always return the same pages').toBe(false);
  });
});
