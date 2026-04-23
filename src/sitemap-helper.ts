/**
 * Sitemap Helper
 *
 * Fetches and parses sitemap.xml (and sitemap index files) to extract all URLs.
 * Uses lightweight regex parsing — no XML library dependency needed.
 * Supports concurrency-limited HEAD requests for fast broken-link detection.
 */

/** Maximum URLs per sitemap file per the XML Sitemap protocol spec (https://sitemaps.org/protocol.html) */
const MAX_SITEMAP_URLS = 50_000;

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export interface SitemapValidation {
  url: string;
  isValid: boolean;
  errors: string[];
  urlCount: number;
  urls: SitemapUrl[];
  isSitemapIndex: boolean;
  childSitemaps: string[];
}

export interface LinkCheckResult {
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
  redirectTarget?: string;
}

/**
 * Fetches and parses a sitemap.xml (or sitemap index).
 * Recursively resolves sitemap index files to collect all URLs.
 *
 * @param sitemapUrl URL of the sitemap or sitemap index to fetch
 * @param maxDepth Maximum recursion depth for sitemap indexes (default: 3).
 *                 Supports 3 levels: sitemap_index.xml → child_index.xml → regular_sitemap.xml
 * @param maxUrls Optional limit: if a sitemap index is provided, applies per child sitemap.
 *                 For regular sitemaps, does not cap but the returned URLs can be sampled by caller.
 */
export async function fetchSitemap(
  sitemapUrl: string,
  maxDepth = 3,
  maxUrls?: number,
): Promise<SitemapValidation> {
  const result: SitemapValidation = {
    url: sitemapUrl,
    isValid: false,
    errors: [],
    urlCount: 0,
    urls: [],
    isSitemapIndex: false,
    childSitemaps: [],
  };

  let body: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(sitemapUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      result.errors.push(`HTTP ${res.status} fetching ${sitemapUrl}`);
      return result;
    }
    body = await res.text();
  } catch (err: any) {
    result.errors.push(
      err?.name === 'AbortError'
        ? `Timeout fetching ${sitemapUrl} (exceeded 30s)`
        : `Network error fetching ${sitemapUrl}: ${err}`,
    );
    return result;
  }

  // Detect sitemap index
  if (body.includes('<sitemapindex')) {
    result.isSitemapIndex = true;
    const sitemapLocs = extractTag(body, 'sitemap', 'loc');
    result.childSitemaps = sitemapLocs;

    if (maxDepth <= 0) {
      result.errors.push('Max sitemap index depth reached, skipping child sitemaps');
      result.isValid = sitemapLocs.length > 0;
      return result;
    }

    for (const childUrl of sitemapLocs) {
      const child = await fetchSitemap(childUrl, maxDepth - 1, maxUrls);
      const childUrls = maxUrls ? sampleUrls(child.urls, maxUrls) : child.urls;
      result.urls.push(...childUrls);
      result.errors.push(...child.errors);
    }

    result.urlCount = result.urls.length;
    result.isValid = result.errors.length === 0 && result.urlCount > 0;
    return result;
  }

  // Regular sitemap — extract <url> entries
  if (!body.includes('<urlset')) {
    result.errors.push('Not a valid sitemap: missing <urlset> root element');
    return result;
  }

  const urlBlocks = body.match(/<url>[\s\S]*?<\/url>/g) || [];
  for (const block of urlBlocks) {
    const loc = extractSingleTag(block, 'loc');
    if (!loc) continue;

    result.urls.push({
      loc,
      lastmod: extractSingleTag(block, 'lastmod') || undefined
    });
  }

  result.urlCount = result.urls.length;

  // Validate
  if (result.urlCount === 0) {
    result.errors.push('Sitemap has no <url> entries');
  }
  if (result.urlCount > MAX_SITEMAP_URLS) {
    result.errors.push(
      `Sitemap exceeds ${MAX_SITEMAP_URLS.toLocaleString()} URL limit (${result.urlCount}). Should use a sitemap index.`,
    );
  }

  result.isValid = result.errors.length === 0 && result.urlCount > 0;
  return result;
}

/**
 * Check a batch of URLs using HEAD requests with concurrency control.
 * Returns status for each URL. Much faster than full Playwright renders.
 */
export async function checkUrlsBatch(
  urls: string[],
  options: {
    concurrency?: number;
    timeoutMs?: number;
    method?: 'HEAD' | 'GET';
    /** Cap on how long to wait after a 429 Retry-After response (default: 30s) */
    retryAfterCapMs?: number;
  } = {},
): Promise<LinkCheckResult[]> {
  const { concurrency = 10, timeoutMs = 10_000, method = 'HEAD', retryAfterCapMs = 30_000 } = options;
  const results: LinkCheckResult[] = [];
  const queue = [...urls];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift()!;
      const result = await checkSingleUrl(url, { timeoutMs, method, retryAfterCapMs });
      results.push(result);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Check a single URL with a HEAD (or GET) request, following up to 1 redirect manually
 * to detect redirect targets.
 */
function buildLinkCheckResult(url: string, res: Response): LinkCheckResult {
  const isRedirect = [301, 302, 307, 308].includes(res.status);
  const redirectTarget = isRedirect ? res.headers.get('location') || undefined : undefined;
  // Only 200 and 304 (Not Modified) are healthy.
  // 405 (Method Not Allowed) on HEAD with Googlebot UA is a real server config issue — surface it distinctly.
  const ok = res.status === 200 || res.status === 304;
  const error = res.status === 405
    ? 'Server returned 405 (Method Not Allowed) for HEAD — server should support HEAD for Googlebot'
    : undefined;
  return { url, status: res.status, ok, redirectTarget, error };
}

/**
 * Parse a Retry-After header value into milliseconds to wait.
 * Supports both seconds (e.g. "120") and HTTP-date (e.g. "Fri, 31 Dec 2025 23:59:59 GMT").
 * Returns the fallback value if the header is missing or unparseable.
 */
function parseRetryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const asNumber = Number(header);
  if (!isNaN(asNumber)) return asNumber * 1_000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

const MAX_RETRIES = 3;

async function checkSingleUrl(
  url: string,
  options: { timeoutMs: number; method: 'HEAD' | 'GET'; retryAfterCapMs: number },
): Promise<LinkCheckResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      const res = await fetch(url, {
        method: options.method,
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const baseWaitMs = parseRetryAfterMs(res.headers.get('retry-after'), 5_000);
        // Exponential backoff: double the wait on each subsequent retry, plus jitter to avoid thundering herd.
        const backoffMs = baseWaitMs * Math.pow(2, attempt);
        const jitterMs = Math.random() * 1_000;
        const waitMs = Math.min(backoffMs + jitterMs, options.retryAfterCapMs);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      return buildLinkCheckResult(url, res);
    } catch (err: any) {
      return {
        url,
        status: null,
        ok: false,
        error: err?.name === 'AbortError' ? 'Timeout' : (err?.message || String(err)),
      };
    }
  }
  // Should not reach here, but satisfy TypeScript.
  return { url, status: 429, ok: false, error: 'Rate limited after retries' };
}

/**
 * Pick a random sample from an array. If the array is smaller than sampleSize,
 * returns the full array.
 */
export function sampleUrls<T>(items: T[], sampleSize: number): T[] {
  if (items.length <= sampleSize) return [...items];
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, sampleSize);
}

/**
 * Follows a single URL through its redirect chain using manual redirect following.
 * Returns the full chain of URLs. Stops at the first non-redirect or when maxHops is reached.
 */
export async function followRedirectChain(
  url: string,
  options: { maxHops?: number; timeoutMs?: number } = {},
): Promise<{ chain: string[]; finalStatus: number | null; error?: string }> {
  const { maxHops = 3, timeoutMs: perHopTimeout = 10_000 } = options;
  const chain: string[] = [url];

  let current = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perHopTimeout);
      const res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (![301, 302, 307, 308].includes(res.status)) {
        return { chain, finalStatus: res.status };
      }

      const location = res.headers.get('location');
      if (!location) {
        return { chain, finalStatus: res.status, error: 'Redirect with no Location header' };
      }

      const next = new URL(location, current).href;
      if (chain.includes(next)) {
        return { chain: [...chain, next], finalStatus: null, error: `Redirect loop detected: ${next}` };
      }
      chain.push(next);
      current = next;
    } catch (err: any) {
      return {
        chain,
        finalStatus: null,
        error: err?.name === 'AbortError' ? 'Timeout' : String(err),
      };
    }
  }

  // If we exhausted maxHops, the chain is still redirecting
  return { chain, finalStatus: null, error: `Still redirecting after ${maxHops} hops` };
}

// --- Internal XML helpers (no dependency needed) ---

function extractTag(xml: string, parentTag: string, childTag: string): string[] {
  const parentPattern = new RegExp(`<${parentTag}>[\\s\\S]*?<\\/${parentTag}>`, 'g');
  const parents = xml.match(parentPattern) || [];
  return parents
    .map((block) => extractSingleTag(block, childTag))
    .filter((v): v is string => v !== null);
}

function extractSingleTag(xml: string, tag: string): string | null {
  // Regex explanation:
  // 1. Match tag opening (possibly with namespaces like <ns:loc> or attributes)
  // 2. Capture content, ignoring possible CDATA wrapper: <![CDATA[ content ]]>
  // 3. Match tag closing
  const regex = new RegExp(`<[^>]*:?${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?\\s*([\\s\\S]*?)\\s*(?:\\]\\]>)?\\s*<\\/[^>]*:?${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}
