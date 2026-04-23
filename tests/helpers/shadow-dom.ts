/**
 * Shadow DOM traversal helper
 *
 * Injects a `window.deepQueryAll(root, selector)` function into the page via
 * `addInitScript()`. This allows all DOM checks to find elements inside open
 * shadow roots without any per-test setup.
 *
 * Usage in beforeEach:
 *   import { injectDeepQueryAll } from '../helpers/shadow-dom';
 *   await injectDeepQueryAll(page);
 *
 * Then in page.evaluate():
 *   window.deepQueryAll(document, 'h1')
 *   // returns Array<{ tag: string; text: string; inShadow: boolean; hostTag?: string }>
 *
 * On pages with no shadow DOM, this behaves identically to querySelectorAll.
 * Open shadow roots are traversed recursively. Closed shadow roots are not
 * accessible (by design) — this mirrors Googlebot's behaviour with shadow DOM.
 */

import type { Page } from '@playwright/test';

export async function injectDeepQueryAll(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const MAX_SHADOW_DEPTH = 10;

    (window as any).deepQueryAll = function deepQueryAll(
      root: Document | ShadowRoot | Element,
      selector: string,
      inShadow = false,
      hostTag?: string,
      depth = 0,
    ): Array<{ element: Element; inShadow: boolean; hostTag?: string }> {
      const results: Array<{ element: Element; inShadow: boolean; hostTag?: string }> = [];

      // Collect matching elements at this level
      for (const el of Array.from(root.querySelectorAll(selector))) {
        results.push({ element: el, inShadow, hostTag });
      }

      // Recurse into open shadow roots (with depth limit to prevent stack overflow)
      if (depth < MAX_SHADOW_DEPTH) {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if ((el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot) {
            results.push(
              ...(window as any).deepQueryAll(
                (el as any).shadowRoot,
                selector,
                true,
                el.tagName.toLowerCase(),
                depth + 1,
              ),
            );
          }
        }
      }

      return results;
    };
  });
}
