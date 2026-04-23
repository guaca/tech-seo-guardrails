/**
 * Route Interceptors
 *
 * Handles robots.txt enforcement and third-party resource blocking.
 * Extends Playwright's page.route() to simulate what Googlebot actually sees.
 */

import type { Page } from '@playwright/test';
import { getRobots, GOOGLEBOT_UA } from '../../src/robots-helper';

/**
 * Converts a glob-style pattern (with `*` as wildcard) into a RegExp.
 * Escapes all regex metacharacters except `*`, which becomes `.*`.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\*/g, '.*'));
}

export interface InterceptorResult {
  blockedByRobotsTxt: string[];
  blockedThirdParty: string[];
}

/**
 * Sets up route interception for robots.txt enforcement and third-party blocking.
 * Returns an object with arrays of blocked URLs for test assertions.
 */
export async function setupInterceptors(
  page: Page,
  options: {
    baseUrl: string;
    enforceRobotsTxt?: boolean;
    blockThirdParty?: string[];
  },
): Promise<InterceptorResult> {
  const result: InterceptorResult = {
    blockedByRobotsTxt: [],
    blockedThirdParty: [],
  };

  const robots = options.enforceRobotsTxt ? await getRobots(options.baseUrl) : null;
  const thirdPartyPatterns = (options.blockThirdParty || []).map(
    (pattern) => globToRegex(pattern),
  );

  if (robots || thirdPartyPatterns.length > 0) {
    await page.route('**/*', (route) => {
      const url = route.request().url();

      // Check robots.txt (only apply to first-party requests)
      let isFirstParty = false;
      try {
        // If baseUrl is http://localhost:3000 and url is http://localhost:3000/api/..., this is true
        isFirstParty = new URL(url).origin === new URL(options.baseUrl).origin;
      } catch {
        // Fallback for relative URLs or malformed URLs
        isFirstParty = url.startsWith(options.baseUrl) || url.startsWith('/');
      }

      if (robots && isFirstParty && !robots.isAllowed(url, GOOGLEBOT_UA)) {
        result.blockedByRobotsTxt.push(url);
        route.abort('blockedbyclient');
        return;
      }

      // Check third-party blocklist
      for (const pattern of thirdPartyPatterns) {
        if (pattern.test(url)) {
          result.blockedThirdParty.push(url);
          route.abort('blockedbyclient');
          return;
        }
      }

      route.continue();
    });
  }

  return result;
}
