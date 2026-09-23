/**
 * Shopify Preview Theme Support
 *
 * Lets the framework test an unpublished Shopify theme served on the same
 * domain as production, gated by a cookie Shopify sets when you visit
 * `<baseUrl>/?preview_theme_id=<id>` (see scripts/shopify-preview-setup.js,
 * wired as Playwright's globalSetup, which captures that cookie once per run
 * via a real navigation — Shopify's cookie schema is undocumented/internal,
 * so we let Shopify set it itself rather than guessing its shape).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getGuardrailsDir } from './load-config';

export const SHOPIFY_STORAGE_STATE_PATH = path.join(getGuardrailsDir(), '.shopify-preview-state.json');

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Whether the Shopify preview-theme mechanism should be active for this run.
 * `SEO_LANE=production` is documented to mean "ignore any staging/preview
 * config and test the live production site directly" — so it always wins,
 * even if SHOPIFY_PREVIEW_THEME_ID is still sitting in .env from local preview
 * testing. Checked in every place that reads SHOPIFY_PREVIEW_THEME_ID so a
 * stale local setting can't silently contaminate a production-lane run.
 */
export function isShopifyPreviewActive(): boolean {
  return !!process.env.SHOPIFY_PREVIEW_THEME_ID && process.env.SEO_LANE !== 'production';
}

/**
 * Returns a `Cookie:` header value carrying the captured preview-theme cookies
 * for the given URL's host, or null if the feature isn't active or nothing
 * was captured. Used by raw `fetch()` call sites (src/robots-helper.ts,
 * src/sitemap-helper.ts) that don't go through Playwright's own cookie-aware
 * `page`/`request` fixtures.
 */
export function getShopifyPreviewCookieHeader(
  targetUrl: string,
  storageStatePath: string = SHOPIFY_STORAGE_STATE_PATH,
): string | null {
  if (!isShopifyPreviewActive()) return null;
  if (!fs.existsSync(storageStatePath)) return null;

  let state: { cookies?: StoredCookie[] };
  try {
    state = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8'));
  } catch {
    return null;
  }
  const cookies = state.cookies ?? [];
  if (cookies.length === 0) return null;

  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return null;
  }

  const matching = cookies.filter((c) => {
    const cookieDomain = c.domain.replace(/^\./, '');
    return host === cookieDomain || host.endsWith(`.${cookieDomain}`);
  });
  if (matching.length === 0) return null;

  return matching.map((c) => `${c.name}=${c.value}`).join('; ');
}
