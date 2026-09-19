/**
 * Unit Tests: Shopify Preview Theme Cookie Header
 *
 * Fast, browser-free checks for getShopifyPreviewCookieHeader(). Writes/removes
 * a real file at SHOPIFY_STORAGE_STATE_PATH per test — safe since it's gitignored
 * and each test cleans up after itself.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { getShopifyPreviewCookieHeader, isShopifyPreviewActive, SHOPIFY_STORAGE_STATE_PATH } from '../../src/shopify-preview';

function writeStorageState(cookies: Array<{ name: string; value: string; domain: string }>) {
  fs.writeFileSync(SHOPIFY_STORAGE_STATE_PATH, JSON.stringify({ cookies, origins: [] }), 'utf-8');
}

test.describe('getShopifyPreviewCookieHeader', () => {
  const originalEnv = process.env.SHOPIFY_PREVIEW_THEME_ID;

  test.afterEach(() => {
    if (originalEnv === undefined) delete process.env.SHOPIFY_PREVIEW_THEME_ID;
    else process.env.SHOPIFY_PREVIEW_THEME_ID = originalEnv;
    if (fs.existsSync(SHOPIFY_STORAGE_STATE_PATH)) fs.unlinkSync(SHOPIFY_STORAGE_STATE_PATH);
  });

  test('returns null when SHOPIFY_PREVIEW_THEME_ID is not set', () => {
    delete process.env.SHOPIFY_PREVIEW_THEME_ID;
    writeStorageState([{ name: 'session', value: 'abc', domain: 'example.com' }]);
    expect(getShopifyPreviewCookieHeader('https://example.com/robots.txt')).toBeNull();
  });

  test('returns null when the env var is set but no storageState file exists', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    if (fs.existsSync(SHOPIFY_STORAGE_STATE_PATH)) fs.unlinkSync(SHOPIFY_STORAGE_STATE_PATH);
    expect(getShopifyPreviewCookieHeader('https://example.com/robots.txt')).toBeNull();
  });

  test('builds a Cookie header from cookies matching the target host', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    writeStorageState([
      { name: 'session', value: 'abc123', domain: 'example.com' },
      { name: 'other_site', value: 'nope', domain: 'other-site.com' },
    ]);
    const header = getShopifyPreviewCookieHeader('https://example.com/robots.txt');
    expect(header).toBe('session=abc123');
  });

  test('matches a leading-dot cookie domain against a subdomain', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    writeStorageState([{ name: 'session', value: 'abc123', domain: '.example.com' }]);
    const header = getShopifyPreviewCookieHeader('https://www.example.com/');
    expect(header).toBe('session=abc123');
  });

  test('returns null when no cookies match the target host', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    writeStorageState([{ name: 'session', value: 'abc123', domain: 'other-site.com' }]);
    expect(getShopifyPreviewCookieHeader('https://example.com/')).toBeNull();
  });

  test('joins multiple matching cookies with "; "', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    writeStorageState([
      { name: 'a', value: '1', domain: 'example.com' },
      { name: 'b', value: '2', domain: 'example.com' },
    ]);
    const header = getShopifyPreviewCookieHeader('https://example.com/');
    expect(header).toBe('a=1; b=2');
  });

  test('SEO_LANE=production always disables the feature, even with a valid theme ID and cookie', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    process.env.SEO_LANE = 'production';
    writeStorageState([{ name: 'session', value: 'abc123', domain: 'example.com' }]);
    try {
      expect(getShopifyPreviewCookieHeader('https://example.com/')).toBeNull();
    } finally {
      delete process.env.SEO_LANE;
    }
  });
});

test.describe('isShopifyPreviewActive', () => {
  const originalThemeId = process.env.SHOPIFY_PREVIEW_THEME_ID;
  const originalLane = process.env.SEO_LANE;

  test.afterEach(() => {
    if (originalThemeId === undefined) delete process.env.SHOPIFY_PREVIEW_THEME_ID;
    else process.env.SHOPIFY_PREVIEW_THEME_ID = originalThemeId;
    if (originalLane === undefined) delete process.env.SEO_LANE;
    else process.env.SEO_LANE = originalLane;
  });

  test('false when SHOPIFY_PREVIEW_THEME_ID is unset', () => {
    delete process.env.SHOPIFY_PREVIEW_THEME_ID;
    delete process.env.SEO_LANE;
    expect(isShopifyPreviewActive()).toBe(false);
  });

  test('true when SHOPIFY_PREVIEW_THEME_ID is set and SEO_LANE is not production', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    delete process.env.SEO_LANE;
    expect(isShopifyPreviewActive()).toBe(true);
    process.env.SEO_LANE = 'merge';
    expect(isShopifyPreviewActive()).toBe(true);
  });

  test('false when SEO_LANE is production, regardless of SHOPIFY_PREVIEW_THEME_ID', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    process.env.SEO_LANE = 'production';
    expect(isShopifyPreviewActive()).toBe(false);
  });
});
