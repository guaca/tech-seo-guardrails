// @ts-check
'use strict';

const { defineConfig } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Load .env from consumer's project root — Playwright resolves .env relative to
// the config file, which lives in node_modules when installed as a dependency.
const _envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(_envPath)) {
  for (const line of fs.readFileSync(_envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// Ensure blob reporter writes to the workspace root, not relative to this config file.
// When the config lives in node_modules/, Playwright resolves relative blob output paths
// from the config directory — this forces an absolute path based on the consumer's cwd.
if (!process.env.PLAYWRIGHT_BLOB_OUTPUT_DIR) {
  process.env.PLAYWRIGHT_BLOB_OUTPUT_DIR = path.join(process.cwd(), 'blob-report');
}

// Googlebot Smartphone user-agent (used for mobile-first indexing)
// Source: https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers
const GOOGLEBOT_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const googlebotUse = {
  channel: 'chrome',
  userAgent: GOOGLEBOT_MOBILE_UA,
  // Phase 1 viewport: Googlebot first renders at standard mobile size,
  // then the beforeEach in seo-dom.spec.ts expands it to the full scrollHeight.
  viewport: { width: 412, height: 732 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

module.exports = defineConfig({
  testDir: path.resolve(__dirname, 'tests'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // Per-test timeout. Integration beforeAll overrides this to 60s via test.setTimeout()
  // so the page load phase has enough headroom without inflating individual test timeouts.
  timeout: 20_000,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    [path.resolve(__dirname, 'src/reporters/seo-summary.js')],
  ],
  use: {
    // TEST_BASE_URL: where Playwright sends requests (your dev server, preview URL, or staging).
    // PROD_BASE_URL: the canonical production URL (used as fallback when TEST_BASE_URL is not set).
    // If neither is set, falls back to http://localhost:3000.
    // See docs/environments.md for scenario examples.
    baseURL: process.env.TEST_BASE_URL || process.env.PROD_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  outputDir: path.join(process.cwd(), 'test-results'),
  projects: [
    // Tier 1: Unit tests — fast config validation, no browser needed
    {
      name: 'unit',
      testMatch: '**/unit/**/*.spec.js',
    },
    // Tier 2: Integration tests — DOM checks with Googlebot emulation
    // Each per-page describe block uses mode:'serial' + beforeAll to load each page once
    // and share it across all ~42 tests. Different pages run in parallel across workers.
    // Deterministic daily-seeded sampling ensures all workers evaluate the same page set.
    {
      name: 'integration',
      testMatch: '**/integration/**/*.spec.js',
      use: {
        ...googlebotUse,
        // beforeAll loads the page once — give navigation enough time for slow pages.
        navigationTimeout: 20_000,
      },
    },
    // Tier 3: E2E tests — sitemap & link health checks
    {
      name: 'e2e',
      testMatch: '**/e2e/**/*.spec.js',
      use: googlebotUse,
    },
  ],
});
