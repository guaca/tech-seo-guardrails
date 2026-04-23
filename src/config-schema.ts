/**
 * Config Schema Validator
 *
 * Validates seo-checks.json structure at the unit test level.
 * Catches misconfigurations before any browser spins up.
 */

export interface ValidationError {
  path: string;
  message: string;
}

const VALID_SEVERITIES = ['blocker', 'warning'];
const REQUIRED_PAGE_FIELDS = ['path', 'description'];
const REQUIRED_FIELDS = ['title', 'canonical', 'metaRobots'];

/**
 * Validates the full seo-checks.json config.
 */
export function validateConfig(config: any): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!config.baseUrl && !process.env.PROD_BASE_URL) {
    errors.push({
      path: 'baseUrl',
      message: 'baseUrl is required. Set it in seo-checks.json or via the PROD_BASE_URL environment variable.',
    });
  } else if (config.baseUrl && typeof config.baseUrl !== 'string') {
    errors.push({ path: 'baseUrl', message: 'baseUrl must be a string' });
  }

  if (config.sampleConfig !== undefined) {
    const sc = config.sampleConfig;
    if (typeof sc !== 'object' || sc === null) {
      errors.push({ path: 'sampleConfig', message: 'sampleConfig must be an object' });
    } else if (
      sc.maxPagesPerTemplate !== undefined &&
      (!Number.isInteger(sc.maxPagesPerTemplate) || sc.maxPagesPerTemplate < 1)
    ) {
      errors.push({
        path: 'sampleConfig.maxPagesPerTemplate',
        message: 'maxPagesPerTemplate must be a positive integer',
      });
    }
  }

  if (!config.pages || !Array.isArray(config.pages) || config.pages.length === 0) {
    errors.push({ path: 'pages', message: 'pages array is required and must not be empty' });
    return errors;
  }

  // Check for duplicate paths — O(n) with Set instead of O(n²) indexOf scan
  const paths = config.pages.map((p: any) => p.path);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) dupes.add(p);
    else seen.add(p);
  }
  if (dupes.size > 0) {
    errors.push({ path: 'pages', message: `Duplicate paths found: ${[...dupes].join(', ')}` });
  }

  // Validate templates if present
  if (config.templates) {
    for (const [name, template] of Object.entries(config.templates as Record<string, any>)) {
      if (!template.seo || typeof template.seo !== 'object') {
        errors.push({ path: `templates.${name}`, message: 'Template must have an seo object' });
      }
      validateSeverities(template.seo || {}, `templates.${name}.seo`, errors);
      if (template.waitForReady && !VALID_WAIT_STRATEGIES.includes(template.waitForReady)) {
        errors.push({
          path: `templates.${name}.waitForReady`,
          message: `waitForReady must be one of: ${VALID_WAIT_STRATEGIES.join(', ')}`,
        });
      }
      if (template.urlPattern !== undefined) {
        if (typeof template.urlPattern !== 'string') {
          errors.push({ path: `templates.${name}.urlPattern`, message: 'urlPattern must be a string' });
        } else {
          try { new RegExp(template.urlPattern); } catch {
            errors.push({ path: `templates.${name}.urlPattern`, message: `urlPattern is not a valid regular expression: "${template.urlPattern}"` });
          }
        }
      }
    }
  }

  // Validate crawlConfig if present
  if (config.crawlConfig !== undefined) {
    const cc = config.crawlConfig;
    if (typeof cc !== 'object' || cc === null) {
      errors.push({ path: 'crawlConfig', message: 'crawlConfig must be an object' });
    } else if (
      cc.maxUrlsPerTemplate !== undefined &&
      (!Number.isInteger(cc.maxUrlsPerTemplate) || cc.maxUrlsPerTemplate < 1)
    ) {
      errors.push({
        path: 'crawlConfig.maxUrlsPerTemplate',
        message: 'maxUrlsPerTemplate must be a positive integer',
      });
    }
  }

  // Validate each page
  for (let i = 0; i < config.pages.length; i++) {
    const page = config.pages[i];
    const prefix = `pages[${i}]`;

    for (const field of REQUIRED_PAGE_FIELDS) {
      if (!page[field]) {
        errors.push({ path: `${prefix}.${field}`, message: `${field} is required` });
      }
    }

    if (page.template && config.templates && !config.templates[page.template]) {
      errors.push({
        path: `${prefix}.template`,
        message: `Template "${page.template}" not found in templates`,
      });
    }

    if (page.seo) {
      const metadata = page.seo.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        errors.push({ path: `${prefix}.seo.metadata`, message: 'metadata category object is required' });
      } else {
        for (const field of REQUIRED_FIELDS) {
          if (!metadata[field] || metadata[field].value === undefined) {
            errors.push({
              path: `${prefix}.seo.metadata.${field}`,
              message: `${field} is required for every page (critical SEO signal)`,
            });
          }
        }

        if (metadata.canonical && metadata.canonical.value !== undefined) {
          const c = metadata.canonical.value;
          const isRelative = typeof c === 'string' && c.startsWith('/');
          if (!isRelative) {
            try {
              const parsed = new URL(c);
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                errors.push({
                  path: `${prefix}.seo.metadata.canonical`,
                  message: `Canonical URL has invalid protocol "${parsed.protocol}". Must be http: or https:.`,
                });
              }
            } catch {
              errors.push({
                path: `${prefix}.seo.metadata.canonical`,
                message: `Invalid canonical URL: "${c}". Use a relative path (e.g. "/about") or an absolute URL.`,
              });
            }
          }
        }
      }

      validateSeverities(page.seo, `${prefix}.seo`, errors);

      // Validate links format
      if (page.seo.linkHealth?.links && Array.isArray(page.seo.linkHealth.links.value)) {
        const links = page.seo.linkHealth.links.value;
        for (let j = 0; j < links.length; j++) {
          const link = links[j];
          if (!link.selector && !link.expectedText) {
            errors.push({
              path: `${prefix}.seo.linkHealth.links.value[${j}]`,
              message: 'Each link entry must have either "selector" or "expectedText" (or both)',
            });
          }
        }
      }

      // Validate structuredData format
      if (page.seo.structuredData) {
        const sd = page.seo.structuredData;
        if (sd.expected && Array.isArray(sd.expected)) {
          for (let j = 0; j < sd.expected.length; j++) {
            if (!sd.expected[j]['@type']) {
              errors.push({
                path: `${prefix}.seo.structuredData.expected[${j}]`,
                message: 'Each structured data entry must have an @type',
              });
            }
            if (sd.expected[j].requiredFields !== undefined && !Array.isArray(sd.expected[j].requiredFields)) {
              errors.push({
                path: `${prefix}.seo.structuredData.expected[${j}].requiredFields`,
                message: 'requiredFields must be an array of strings',
              });
            }
          }
        }
      }
    }
  }

  return errors;
}

const VALID_WAIT_STRATEGIES = ['load', 'networkidle'];

const VALID_LANES = ['pr', 'merge', 'scheduled'];

function validateCheckObject(
  obj: any,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    errors.push({ path, message: 'Check must be an object' });
    return;
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    errors.push({ path: `${path}.enabled`, message: 'enabled must be a boolean' });
  }
  if (obj.severity && !VALID_SEVERITIES.includes(obj.severity)) {
    errors.push({
      path: `${path}.severity`,
      message: `Invalid severity "${obj.severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
    });
  }
}

function validateSeverities(
  seo: Record<string, any>,
  prefix: string,
  errors: ValidationError[],
): void {
  for (const [groupName, group] of Object.entries(seo)) {
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      // Group level can have lane and waitForReady
      if ((group as any).lane !== undefined) {
        const lanes = Array.isArray((group as any).lane) ? (group as any).lane : [(group as any).lane];
        for (const l of lanes) {
          if (!VALID_LANES.includes(l)) {
            errors.push({
              path: `${prefix}.${groupName}.lane`,
              message: `Invalid lane "${l}". Must be one of: ${VALID_LANES.join(', ')}`,
            });
          }
        }
      }

      if ((group as any).waitForReady && !VALID_WAIT_STRATEGIES.includes((group as any).waitForReady)) {
        errors.push({
          path: `${prefix}.${groupName}.waitForReady`,
          message: `Invalid wait strategy "${(group as any).waitForReady}". Must be one of: ${VALID_WAIT_STRATEGIES.join(', ')}`,
        });
      }

      // Validate each check within the group
      for (const [checkName, checkValue] of Object.entries(group)) {
        if (['severity', 'lane', 'waitForReady', 'enabled'].includes(checkName)) continue;

        validateCheckObject(checkValue, `${prefix}.${groupName}.${checkName}`, errors);
      }
    }
  }
}
