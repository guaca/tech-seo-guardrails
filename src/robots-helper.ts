/**
 * Robots.txt Helper
 *
 * Fetches and parses robots.txt once per worker, caches globally.
 * Used by route interceptors to enforce Googlebot crawl rules.
 */

import robotsParser from 'robots-parser';
import { getShopifyPreviewCookieHeader } from './shopify-preview';

// Short token used to match `User-agent:` directives in robots.txt — NOT a browser
// User-Agent header. For the actual browser context, use GOOGLEBOT_SMARTPHONE_UA.
export const GOOGLEBOT_UA = 'Googlebot';

// Full Googlebot Smartphone User-Agent string (mobile-first indexing), for the
// browser context's real HTTP User-Agent header.
// Source: https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers
export const GOOGLEBOT_SMARTPHONE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const _robotsCache = new Map<string, ReturnType<typeof robotsParser> | null>();

export async function getRobots(
  baseUrl: string,
): Promise<ReturnType<typeof robotsParser> | null> {
  if (_robotsCache.has(baseUrl)) return _robotsCache.get(baseUrl)!;
  try {
    const url = `${baseUrl}/robots.txt`;
    const cookie = getShopifyPreviewCookieHeader(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
    });
    clearTimeout(timer);
    if (res.ok) {
      _robotsCache.set(baseUrl, robotsParser(url, await res.text()));
    } else {
      _robotsCache.set(baseUrl, null);
    }
  } catch (err) {
    console.warn(`[robots-helper] Failed to fetch robots.txt from ${baseUrl}: ${err}`);
    _robotsCache.set(baseUrl, null);
  }
  return _robotsCache.get(baseUrl)!;
}

/**
 * Resets the robots.txt cache. Useful for testing.
 */
export function resetRobotsCache(): void {
  _robotsCache.clear();
}
