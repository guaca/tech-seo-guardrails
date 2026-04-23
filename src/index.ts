/**
 * @company/seo-guardrails — Public API
 *
 * Exports everything a consumer repo needs to run SEO guardrail tests.
 */

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import * as path from 'path';

export { resolveConfig, resolvePageConfig, filterByLane, samplePagesByTemplate } from './config-resolver';
export type { SeoConfig, PageConfig, ResolvedPageConfig, WaitForReady } from './config-resolver';
export { validateConfig } from './config-schema';
export type { ValidationError } from './config-schema';
export { loadSeoConfig, getProjectRoot, getPackageRoot } from './load-config';
export { getRobots, resetRobotsCache, GOOGLEBOT_UA } from './robots-helper';
export { fetchSitemap, checkUrlsBatch, sampleUrls } from './sitemap-helper';
export type { SitemapUrl, SitemapValidation, LinkCheckResult } from './sitemap-helper';

// Googlebot Smartphone user-agent (used for mobile-first indexing)
const GOOGLEBOT_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export interface SeoGuardrailOptions {
  /** URL of the site to test */
  baseURL: string;
  /** Path to seo-checks.json */
  configPath?: string;
  /** Which test tier to run: 'unit', 'integration', 'e2e', or 'all' */
  tier?: 'unit' | 'integration' | 'e2e' | 'all';
  /** Optional web server command to start before tests */
  webServer?: { command: string; url: string; timeout?: number };
  /**
   * Override the browser user-agent string.
   * Default: Googlebot Smartphone (mobile-first indexing).
   * Example override for desktop crawl testing: set to the Googlebot Desktop UA.
   */
  userAgent?: string;
  /**
   * Override the viewport dimensions.
   * Default: { width: 412, height: 732 } (Googlebot Smartphone initial viewport).
   */
  viewport?: { width: number; height: number };
  /**
   * Override the device scale factor.
   * Default: 2.625 (Googlebot Smartphone).
   */
  deviceScaleFactor?: number;
}

/**
 * Creates a Playwright config pre-configured for SEO guardrail testing.
 * Consumer repos import this and just pass their site-specific options.
 *
 * @example
 * ```ts
 * import { defineSeoConfig } from '@company/seo-guardrails';
 * export default defineSeoConfig({
 *   baseURL: 'https://staging.mysite.com',
 *   configPath: './seo-checks.json',
 *   tier: 'integration',
 * });
 * ```
 */
export function defineSeoConfig(options: SeoGuardrailOptions): PlaywrightTestConfig {
  const testDir = path.resolve(__dirname, '..', 'tests');
  const tier = options.tier || 'all';

  const projects: PlaywrightTestConfig['projects'] = [];

  if (tier === 'unit' || tier === 'all') {
    projects.push({
      name: 'unit',
      testMatch: '**/unit/**',
    });
  }

  const botUA = options.userAgent ?? GOOGLEBOT_MOBILE_UA;
  const botViewport = options.viewport ?? { width: 412, height: 732 };
  const botScaleFactor = options.deviceScaleFactor ?? 2.625;

  if (tier === 'integration' || tier === 'all') {
    projects.push({
      name: 'integration',
      testMatch: '**/integration/**',
      use: {
        channel: 'chrome',
        userAgent: botUA,
        viewport: botViewport,
        deviceScaleFactor: botScaleFactor,
        isMobile: true,
        hasTouch: true,
      },
    });
  }

  if (tier === 'e2e' || tier === 'all') {
    projects.push({
      name: 'e2e',
      testMatch: '**/e2e/**',
      use: {
        channel: 'chrome',
        userAgent: botUA,
        viewport: botViewport,
        deviceScaleFactor: botScaleFactor,
        isMobile: true,
        hasTouch: true,
      },
    });
  }

  return defineConfig({
    testDir,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [
      ['html', { open: 'never' }],
      ['list'],
      [path.resolve(__dirname, '..', 'src/reporters/seo-summary.ts')],
    ],
    use: {
      baseURL: options.baseURL,
      trace: 'on-first-retry',
      screenshot: 'only-on-failure',
    },
    outputDir: path.join(process.cwd(), 'test-results'),
    projects,
    ...(options.webServer
      ? {
          webServer: {
            command: options.webServer.command,
            url: options.webServer.url,
            reuseExistingServer: !process.env.CI,
            timeout: options.webServer.timeout || 30_000,
          },
        }
      : {}),
  });
}
