/**
 * Config Resolver
 *
 * Merges template defaults with page-specific overrides and filters
 * checks by lane. This keeps per-page configs lean — pages only need
 * to specify what's unique to them.
 */

export interface SeoConfig {
  baseUrl?: string;
  templates?: Record<string, TemplateConfig>;
  pages: PageConfig[];
}

export interface TemplateConfig {
  urlPattern?: string;
  waitForReady?: WaitForReady;
  seo: Record<string, any>;
}

export type WaitForReady = 'load' | 'networkidle';

export interface PageConfig {
  path: string;
  template?: string;
  description: string;
  waitForReady?: WaitForReady;
  seo: Record<string, any>;
}

export interface ResolvedPageConfig extends PageConfig {
  waitForReady: WaitForReady;
  seo: Record<string, any>;
}

/**
 * Stable deep-equal check for two values (primitives, plain objects, arrays).
 * Used by deepMerge to deduplicate cumulative arrays without JSON round-tripping.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Deep-merge two objects. Page values take precedence over template values.
 * Arrays are replaced by default, except for specific "cumulative" fields
 * like 'links' or 'anchorTextBlocklist' which are concatenated.
 */
function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  const cumulativeFields = ['links', 'anchorTextBlocklist'];

  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      result[key] !== null
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else if (Array.isArray(override[key]) && Array.isArray(result[key]) && cumulativeFields.includes(key)) {
      // For cumulative fields, concatenate arrays and remove duplicates via deep equality
      const merged = [...result[key]];
      for (const item of override[key]) {
        if (!merged.some((existing) => deepEqual(existing, item))) {
          merged.push(item);
        }
      }
      result[key] = merged;
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Resolves a page config by merging template defaults with page overrides.
 */
export function resolvePageConfig(
  page: PageConfig,
  templates: Record<string, TemplateConfig> = {},
): ResolvedPageConfig {
  const templateName = page.template;
  const template = templateName ? templates[templateName] : undefined;

  const defaultWaitForReady: WaitForReady = 'networkidle';

  if (!template) {
    return {
      ...page,
      waitForReady: page.waitForReady ?? defaultWaitForReady,
    };
  }

  const mergedSeo = deepMerge(template.seo || {}, page.seo || {});
  const waitForReady = page.waitForReady ?? template.waitForReady ?? defaultWaitForReady;

  return {
    ...page,
    waitForReady,
    seo: mergedSeo,
  };
}

/**
 * Filters a resolved page config to only include checks that match the given lane.
 * If no lane is specified, all checks are included.
 * Checks without a `lane` field run in all lanes.
 */
export function filterByLane(
  seo: Record<string, any>,
  lane?: string,
): Record<string, any> {
  if (!lane) return seo;

  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(seo)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.lane) {
      const lanes: string[] = Array.isArray(value.lane) ? value.lane : [value.lane];
      if (lanes.includes(lane)) {
        filtered[key] = value;
      }
    } else {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Filters out check groups and individual checks that have been explicitly
 * disabled with `"enabled": false`. Recursive to handle the Strict Object Schema.
 */
export function filterDisabled(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.enabled === false) {
        continue;
      }
      result[key] = filterDisabled(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolves all pages in a config, applying template defaults, lane filtering,
 * and stripping any check groups with `"enabled": false`.
 */
export function resolveConfig(config: SeoConfig, lane?: string): ResolvedPageConfig[] {
  return config.pages.map((page) => {
    const resolved = resolvePageConfig(page, config.templates);
    const laneFiltered = filterByLane(resolved.seo, lane);
    return {
      ...resolved,
      seo: filterDisabled(laneFiltered),
    };
  });
}

/**
 * Samples pages by template, capping each template group at `limit` pages.
 * If a group has fewer pages than the limit, all are kept.
 * Pages without a template are grouped under '(unassigned)'.
 *
 * Uses a seeded LCG shuffle so all Playwright worker processes in one CI run
 * produce the same sample (same date = same seed). Coverage rotates daily.
 * Pass an explicit `seed` in tests to get deterministic, reproducible results.
 */
export function samplePagesByTemplate(
  pages: ResolvedPageConfig[],
  limit: number,
  seed?: number,
): ResolvedPageConfig[] {
  // Default seed: today as an integer (rotates daily, stable within one run)
  const s = seed ?? Math.floor(Date.now() / 86_400_000);
  // LCG (Numerical Recipes constants)
  let state = s >>> 0;
  const next = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  const groups = new Map<string, ResolvedPageConfig[]>();

  for (const page of pages) {
    const key = page.template ?? '(unassigned)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(page);
  }

  const sampled: ResolvedPageConfig[] = [];
  for (const [, group] of groups) {
    if (group.length <= limit) {
      sampled.push(...group);
    } else {
      // Seeded Fisher-Yates shuffle then slice
      const shuffled = [...group];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      sampled.push(...shuffled.slice(0, limit));
    }
  }

  return sampled;
}
