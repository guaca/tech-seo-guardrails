/**
 * Unit Tests: Shopify Preview Theme Cookie Header
 *
 * Fast, browser-free checks for getShopifyPreviewCookieHeader(). Each test
 * writes its own uniquely-named temp file and passes it explicitly as the
 * storageStatePath argument — playwright.config.js runs this project with
 * fullyParallel: true, so tests in this describe block can execute on
 * different workers at the same moment. They used to all share the one
 * fixed SHOPIFY_STORAGE_STATE_PATH, which raced (one test would read the
 * cookies another concurrently-running test had just written).
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getShopifyPreviewCookieHeader, isShopifyPreviewActive } from '../../src/shopify-preview';

let uniqueId = 0;
function uniqueStatePath(): string {
  return path.join(os.tmpdir(), `shopify-preview-test-${process.pid}-${Date.now()}-${uniqueId++}.json`);
}

function writeStorageState(cookies: Array<{ name: string; value: string; domain: string }>): string {
  const statePath = uniqueStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }), 'utf-8');
  return statePath;
}

test.describe('getShopifyPreviewCookieHeader', () => {
  const originalEnv = process.env.SHOPIFY_PREVIEW_THEME_ID;
  const createdPaths: string[] = [];

  test.afterEach(() => {
    if (originalEnv === undefined) delete process.env.SHOPIFY_PREVIEW_THEME_ID;
    else process.env.SHOPIFY_PREVIEW_THEME_ID = originalEnv;
    for (const p of createdPaths.splice(0)) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  test('returns null when SHOPIFY_PREVIEW_THEME_ID is not set', () => {
    delete process.env.SHOPIFY_PREVIEW_THEME_ID;
    const statePath = writeStorageState([{ name: 'session', value: 'abc', domain: 'example.com' }]);
    createdPaths.push(statePath);
    expect(getShopifyPreviewCookieHeader('https://example.com/robots.txt', statePath)).toBeNull();
  });

  test('returns null when the env var is set but no storageState file exists', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    const statePath = uniqueStatePath(); // deliberately never written
    expect(getShopifyPreviewCookieHeader('https://example.com/robots.txt', statePath)).toBeNull();
  });

  test('builds a Cookie header from cookies matching the target host', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    const statePath = writeStorageState([
      { name: 'session', value: 'abc123', domain: 'example.com' },
      { name: 'other_site', value: 'nope', domain: 'other-site.com' },
    ]);
    createdPaths.push(statePath);
    const header = getShopifyPreviewCookieHeader('https://example.com/robots.txt', statePath);
    expect(header).toBe('session=abc123');
  });

  test('matches a leading-dot cookie domain against a subdomain', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    const statePath = writeStorageState([{ name: 'session', value: 'abc123', domain: '.example.com' }]);
    createdPaths.push(statePath);
    const header = getShopifyPreviewCookieHeader('https://www.example.com/', statePath);
    expect(header).toBe('session=abc123');
  });

  test('returns null when no cookies match the target host', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    const statePath = writeStorageState([{ name: 'session', value: 'abc123', domain: 'other-site.com' }]);
    createdPaths.push(statePath);
    expect(getShopifyPreviewCookieHeader('https://example.com/', statePath)).toBeNull();
  });

  test('joins multiple matching cookies with "; "', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    const statePath = writeStorageState([
      { name: 'a', value: '1', domain: 'example.com' },
      { name: 'b', value: '2', domain: 'example.com' },
    ]);
    createdPaths.push(statePath);
    const header = getShopifyPreviewCookieHeader('https://example.com/', statePath);
    expect(header).toBe('a=1; b=2');
  });

  test('SEO_LANE=production always disables the feature, even with a valid theme ID and cookie', () => {
    process.env.SHOPIFY_PREVIEW_THEME_ID = '999';
    process.env.SEO_LANE = 'production';
    const statePath = writeStorageState([{ name: 'session', value: 'abc123', domain: 'example.com' }]);
    createdPaths.push(statePath);
    try {
      expect(getShopifyPreviewCookieHeader('https://example.com/', statePath)).toBeNull();
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
