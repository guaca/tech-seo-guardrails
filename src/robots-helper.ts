/**
 * Robots.txt Helper
 *
 * Fetches and parses robots.txt once per worker, caches globally.
 * Used by route interceptors to enforce Googlebot crawl rules.
 */

import robotsParser from 'robots-parser';

export const GOOGLEBOT_UA = 'Googlebot';

const _robotsCache = new Map<string, ReturnType<typeof robotsParser> | null>();

export async function getRobots(
  baseUrl: string,
): Promise<ReturnType<typeof robotsParser> | null> {
  if (_robotsCache.has(baseUrl)) return _robotsCache.get(baseUrl)!;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/robots.txt`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      _robotsCache.set(baseUrl, robotsParser(`${baseUrl}/robots.txt`, await res.text()));
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
