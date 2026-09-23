#!/usr/bin/env node
/**
 * Playwright globalSetup — captures the Shopify unpublished-theme preview
 * cookie once per run, so every test navigates as if it already visited
 * `?preview_theme_id=...` (see docs/environments.md#shopify-preview-themes).
 *
 * No-op unless SHOPIFY_PREVIEW_THEME_ID is set.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { SHOPIFY_STORAGE_STATE_PATH, isShopifyPreviewActive } = require('../src/shopify-preview');

module.exports = async function globalSetup() {
  // playwright.config.js already gates whether this script even runs, but
  // guard again here too — SEO_LANE=production must always mean "test the
  // real live site," never a preview theme, regardless of how this is invoked.
  if (!isShopifyPreviewActive()) return;
  const themeId = process.env.SHOPIFY_PREVIEW_THEME_ID;

  const baseUrl = process.env.TEST_BASE_URL || process.env.PROD_BASE_URL;
  if (!baseUrl) {
    console.warn(
      '[shopify-preview] SHOPIFY_PREVIEW_THEME_ID is set but neither TEST_BASE_URL nor PROD_BASE_URL is — skipping preview theme setup.',
    );
    return;
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Shopify sets its preview-theme cookie on this request and 302s to the
    // clean URL — page.goto() follows the redirect automatically.
    await page.goto(`${baseUrl.replace(/\/$/, '')}/?preview_theme_id=${encodeURIComponent(themeId)}`);
    fs.mkdirSync(path.dirname(SHOPIFY_STORAGE_STATE_PATH), { recursive: true });
    await context.storageState({ path: SHOPIFY_STORAGE_STATE_PATH });
    console.log(`[shopify-preview] Preview theme cookie captured for theme ${themeId}.`);
  } finally {
    await browser.close();
  }
};
