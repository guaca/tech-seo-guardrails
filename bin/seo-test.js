#!/usr/bin/env node
/**
 * seo-test — CLI wrapper for running SEO guardrail tests.
 *
 * Loads .env from the consumer's project root, then invokes Playwright
 * with the package's built-in config. All arguments are forwarded.
 *
 * Usage:
 *   npx seo-test                          # run all tiers
 *   npx seo-test --project=unit           # unit only
 *   npx seo-test --project=integration    # integration only
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Load .env from consumer's project root (lightweight, no dependency) ──────

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val; // don't override existing
  }
}

// ── Always resolve PROD_BASE_URL from seo-checks.json if not already set ──────
// This ensures E2E tests (which always run against production) use the correct
// base URL regardless of SEO_LANE or TEST_BASE_URL.

if (!process.env.PROD_BASE_URL) {
  const seoConfigPath = path.join(process.cwd(), 'seo-checks.json');
  if (fs.existsSync(seoConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(seoConfigPath, 'utf-8'));
      if (config.baseUrl) {
        process.env.PROD_BASE_URL = config.baseUrl;
      }
    } catch (e) {
      // ignore parse errors here, core tests will handle it
    }
  }
}

// ── Process SEO_LANE=production logic ──────────────────────────────────────────

if (process.env.SEO_LANE === 'production') {
  const prodUrl = process.env.PROD_BASE_URL;

  if (!prodUrl) {
    process.stderr.write('\n  Error: Cannot run in production lane. PROD_BASE_URL or seo-checks.json baseUrl must be set.\n\n');
    process.exit(1);
  }

  process.env.TEST_BASE_URL = prodUrl;
  process.stdout.write(`\n  Running in production lane — targeting: ${prodUrl}\n\n`);
}

// ── Run Playwright with the package's config ─────────────────────────────────

const configPath = path.resolve(__dirname, '..', 'playwright.config.js');
const args = process.argv.slice(2).join(' ');
const command = `npx playwright test --config="${configPath}" ${args}`;

try {
  execSync(command, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
} catch (err) {
  process.exit(err.status || 1);
}
