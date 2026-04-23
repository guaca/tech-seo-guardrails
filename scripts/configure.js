#!/usr/bin/env node
/**
 * scripts/configure.js — Interactive check selection & severity manager
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Select, Toggle, MultiSelect, Input } = require('enquirer');
const pc = require('picocolors');

const CWD = process.cwd();
const PKG_ROOT = path.resolve(__dirname, '..');
const isInstalledDep = __dirname.includes('node_modules');
const CONFIG_CANDIDATES = [
  path.join(CWD, 'generator-config.json'),
  path.join(CWD, 'seo-checks.json')
];

// Master list of all supported SEO check categories and their sub-checks
const MASTER_SCHEMA = {
  metadata: {
    title: { default: 'TODO', desc: 'Exact match against the page <title>' },
    h1: { default: 'TODO', desc: 'Exact match against the first <h1>' },
    metaDescription: { default: 'TODO', desc: 'Exact match against the <meta name="description">' },
    canonical: { default: 'TODO', desc: 'Exact match against <link rel="canonical">' },
    metaRobots: { default: '', desc: 'Exact match against <meta name="robots">' },
    maxCanonicalTags: { default: 1, desc: 'Page must not have more than this many canonical tags' },
    maxRobotsTags: { default: 1, desc: 'Page must not have more than this many meta robots tags' },
    selfReferencingCanonical: { default: true, desc: 'Canonical href must equal the current page URL' },
    hreflang: { default: null, desc: 'Asserts hreflang tags exist with the correct URLs' },
    hasCharset: { default: true, desc: 'Page must have <meta charset>' },
    hasViewport: { default: true, desc: 'Page must have <meta name="viewport">' },
    hasFavicon: { default: true, desc: 'Page must have a favicon' },
    maxTitleTags: { default: 1, desc: 'Page must not have multiple <title> tags' }
  },
  httpChecks: {
    expectedStatusCode: { default: 200, desc: 'Asserts the page returns the expected HTTP status (usually 200 or 304)' },
    xRobotsTag: { default: null, desc: 'Asserts X-Robots-Tag header matches or is absent' },
    maxRedirects: { default: 1, desc: 'Page must not exceed this many redirects before failing' },
    canonicalMustResolve: { default: true, desc: 'HEAD request to the canonical URL must return 200 or 304' },
    robotsTxtEnforcement: { default: true, desc: 'Page URL and critical CSS/JS must be allowed by robots.txt' }
  },
  images: {
    allImagesHaveAlt: { default: true, desc: 'Every <img> must have a non-empty alt attribute' },
    allImagesHaveDimensions: { default: true, desc: 'Every <img> must have explicit width and height' },
    lcpImageNotLazy: { default: true, desc: 'LCP image must not have loading="lazy"' },
    lcpImageShouldHaveFetchPriority: { default: true, desc: 'LCP image must have fetchpriority="high"' },
    lcpSrcsetShouldReturn200: { default: false, desc: 'Every URL in LCP srcset must return HTTP 200 or 304' }
  },
  linkHealth: {
    noEmptyHrefs: { default: true, desc: 'Links must not have empty or # href attributes' },
    noJavascriptHrefs: { default: true, desc: 'Links must not use javascript: hrefs' },
    internalLinksNoCrawlBlock: { default: true, desc: 'Internal links must not have rel="nofollow"' },
    externalLinksHaveNoopener: { default: true, desc: 'External target="_blank" links must have rel="noopener"' },
    checkBrokenInternalLinks: { default: false, desc: 'HEAD-requests all internal links to catch broken links' },
    anchorTextBlocklist: { default: ['click here'], desc: 'Links must not use generic text like "click here"' },
    links: { default: [], desc: 'Asserts that specific critical links are visible on the page' }
  },
  headingHierarchy: {
    noSkippedLevels: { default: true, desc: 'No jump larger than 1 heading level (e.g., H1 to H3)' },
    noEmptyHeadings: { default: true, desc: 'All heading tags must have non-empty text content' }
  },
  renderingValidation: {
    noHiddenSeoContent: { default: true, desc: 'H1 tags must not be hidden via CSS' },
    noFailedRequests: { default: true, desc: 'No CSS, JS, font, or document requests fail to load' },
    noMixedContent: { default: true, desc: 'HTTPS page must not load HTTP resources' },
    noVhTrap: { default: true, desc: 'No element fills >= 90% of expanded viewport without max-height' },
    blockThirdParty: { default: [], desc: 'Glob patterns of third-party domains to block during testing' }
  },
  contentQuality: {
    minWordCount: { default: 100, desc: 'Page must have at least this many words of visible text' }
  },
  ogTags: {
    tags: { default: { 'og:type': 'website' }, desc: 'Asserts specific Open Graph tags are present (requires SF custom extraction to auto-populate)' },
    requireImage: { default: true, desc: 'Asserts og:image is present and returns a valid image (requires SF custom extraction to auto-populate)' }
  },
  twitterCards: {
    tags: { default: { 'twitter:card': 'summary' }, desc: 'Asserts specific Twitter Card tags are present (requires SF custom extraction to auto-populate)' }
  },
  structuredData: {
    expected: { default: [], desc: 'Asserts JSON-LD blocks match expected @type and required fields (requires SF structured data extraction to auto-populate)' },
    shouldBeVisibleOnPage: { default: true, desc: 'JSON-LD Product price must be visible in rendered HTML text' },
    priceSelector: { default: '', desc: 'Optional CSS selector to locate the price (if empty, checks entire page body)' }
  },
  mobileUsability: {
    minTapTargetSize: { default: 48, desc: 'Interactive elements must be at least this many px wide/high' },
    minFontSizePx: { default: 12, desc: 'Visible text must have computed font size >= this many px' }
  },
  lazyContent: {
    selector: { default: '', desc: 'CSS selector for lazy-loaded element that must be visible after scrolling' },
    expectedText: { default: '', desc: 'Text that must be inside the lazy-loaded element' }
  }
};

async function main() {
  console.log(`\n  ${pc.bold(pc.blue('SEO Guardrails Configuration'))}`);
  console.log(`  ──────────────────────────────────────────────────────────────`);

  let configPath = CONFIG_CANDIDATES.find(p => fs.existsSync(p));
  
  if (!configPath) {
    console.error(`\n  ${pc.red('Error:')} No configuration file found.`);
    console.log(`  Run ${pc.cyan('npm run setup')} or ${pc.cyan('npm run init-config')} first.\n`);
    process.exit(1);
  }

  console.log(`  Loading: ${pc.green(path.basename(configPath))}`);

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`\n  ${pc.red('Error:')} Failed to parse ${configPath}`);
    console.error(`  ${err.message}\n`);
    process.exit(1);
  }

  const isGenerator = path.basename(configPath) === 'generator-config.json';
  const templates = config.templates || {};
  const templateNames = Object.keys(templates);

  if (templateNames.length === 0) {
    console.error(`\n  ${pc.red('Error:')} No templates found in configuration.\n`);
    process.exit(1);
  }

  const categories = Object.keys(MASTER_SCHEMA);

  function hasConfiguredChecks(tName) {
    const c = isGenerator ? (templates[tName].checks || {}) : (templates[tName].seo || {});
    for (const catObj of Object.values(c)) {
      if (catObj && typeof catObj === 'object' && catObj.enabled !== false) {
        for (const [k, v] of Object.entries(catObj)) {
          if (k !== 'enabled' && v && typeof v === 'object' && v.enabled !== false) return true;
        }
      }
    }
    return false;
  }

  // Outer loop: Template Selection
  while (true) {
    const templateChoices = templateNames.map(t => {
      const isConfigured = hasConfiguredChecks(t);
      const icon = isConfigured ? pc.green('✔') : pc.dim('○');
      return { name: t, message: `${icon} ${t}` };
    });

    const templatePrompt = new Select({
      name: 'template',
      message: 'Select a template to configure:',
      choices: [...templateChoices, { name: '__save_exit__', message: pc.bold(pc.green('✔ Save and Exit')) }]
    });

    const selectedTemplate = await templatePrompt.run();

    if (selectedTemplate === '__save_exit__') {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`\n  ${pc.green('✓')} Configuration saved to ${pc.bold(configPath)}`);
      if (isGenerator) {
        const genCmd = isInstalledDep ? 'npm run seo:generate' : 'npm run generate';
        console.log(`  ${pc.yellow('Note:')} Remember to run ${pc.bold(genCmd)} to apply these changes to your pages.\n`);
      } else {
        console.log(`  Changes will be reflected in your next test run.\n`);
      }
      return;
    }

    const template = templates[selectedTemplate];
    
    // In generator-config, checks are in 'checks'. In seo-checks, they are in 'seo'.
    let checksContainer = isGenerator ? (template.checks || {}) : (template.seo || {});

    // Template Cloning Feature
    if (Object.keys(checksContainer).length === 0) {
      const configuredTemplates = templateNames.filter(t => {
        if (t === selectedTemplate) return false;
        const c = isGenerator ? (templates[t].checks || {}) : (templates[t].seo || {});
        return Object.keys(c).length > 0;
      });

      if (configuredTemplates.length > 0) {
        const copyPrompt = new Select({
          name: 'copyFrom',
          message: `[${pc.cyan(selectedTemplate)}] has no checks configured. Copy from another template?`,
          choices: ['No, configure manually', ...configuredTemplates]
        });
        const copyChoice = await copyPrompt.run();
        if (copyChoice !== 'No, configure manually') {
           const sourceContainer = isGenerator ? templates[copyChoice].checks : templates[copyChoice].seo;
           const cloned = JSON.parse(JSON.stringify(sourceContainer));
           if (isGenerator) {
             template.checks = cloned;
             checksContainer = template.checks;
           } else {
             template.seo = cloned;
             checksContainer = template.seo;
           }
           console.log(`  ${pc.green('✓')} Copied configuration from ${pc.bold(copyChoice)}.\n`);
        }
      }
    }

    // Inner loop: Category Selection
    while (true) {
      const categoryChoices = categories.map(cat => {
        const exists = !!checksContainer[cat];
        const isEnabled = exists && checksContainer[cat].enabled !== false;
        const label = isEnabled ? pc.green(cat) : (exists ? pc.yellow(cat) : pc.dim(cat));
        const status = isEnabled ? pc.dim(' (enabled)') : (exists ? pc.dim(' (disabled)') : pc.dim(' (missing)'));
        return { name: cat, message: label + status };
      });

      const categoryPrompt = new Select({
        name: 'category',
        message: `Configure [${pc.cyan(selectedTemplate)}] — Select category:`,
        choices: [...categoryChoices, pc.dim('← Back to templates')]
      });

      const category = await categoryPrompt.run();

      if (category === pc.dim('← Back to templates')) {
        break; // Return to the Template Selection loop without losing state
      }

      // Initialize category if it doesn't exist
      if (!checksContainer[category]) {
        const defaults = MASTER_SCHEMA[category];
        const newGroup = { enabled: true };
        for (const [key, meta] of Object.entries(defaults)) {
          newGroup[key] = { enabled: false, severity: 'warning', value: meta.default };
        }
        checksContainer[category] = newGroup;
        // Make sure the newly initialized container is attached to the template object
        if (isGenerator) {
          template.checks = checksContainer;
        } else {
          template.seo = checksContainer;
        }
      }

      const categoryObj = checksContainer[category];
      const subChecks = Object.keys(categoryObj).filter(k => !['enabled', 'severity', 'lane', 'waitForReady'].includes(k));

      if (subChecks.length === 0) {
        // Entire category toggle
        const enabled = await new Toggle({
          message: `Enable ${category}?`,
          initial: categoryObj.enabled !== false
        }).run();
        categoryObj.enabled = enabled;
        continue;
      }

      // Innermost loop: Sub-check configuration
      while (true) {
        const allEnabled = subChecks.every(sc => categoryObj[sc].enabled !== false);
        const toggleAllMsg = allEnabled ? pc.yellow('Disable All') : pc.green('Enable All');

        const subCheckChoices = subChecks.map(sc => {
          const obj = categoryObj[sc];
          const isEnabled = obj.enabled !== false;
          const status = isEnabled ? pc.green('on') : pc.red('off');
          const sev = isEnabled ? pc.dim(` [${obj.severity || 'warning'}]`) : '';
          const desc = MASTER_SCHEMA[category]?.[sc]?.desc || '';
          
          let valLabel = '';
          if (obj.value !== undefined && typeof obj.value !== 'object') {
            valLabel = ` (value: ${obj.value})`;
          }

          return { 
            name: sc, 
            message: `${sc.padEnd(30)}`,
            hint: `${status}${sev}${desc ? pc.dim(' — ' + desc) : ''}${pc.gray(valLabel)}`
          };
        });

        const subCheckPrompt = new Select({
          name: 'action',
          message: `Configure [${pc.cyan(category)}] — Select check to modify:`,
          choices: [
            { name: '__toggle_all__', message: toggleAllMsg },
            ...subCheckChoices, 
            pc.dim('← Back to categories')
          ],
          // Ensure hint is visible
          format() {
            return '';
          }
        });

        const action = await subCheckPrompt.run();

        if (action === pc.dim('← Back to categories')) {
          // Auto-update category enablement based on sub-checks
          const hasEnabledSubCheck = subChecks.some(sc => categoryObj[sc].enabled !== false);
          categoryObj.enabled = hasEnabledSubCheck;
          break;
        }

        if (action === '__toggle_all__') {
          const newState = !allEnabled;
          for (const sc of subChecks) {
            categoryObj[sc].enabled = newState;
            // When bulk-enabling, ensure we use 'warning' as the starting point.
            // This prevents old 'blocker' defaults from accidentally breaking the build
            // when a user is just trying to get visibility.
            if (newState && (!categoryObj[sc].severity || categoryObj[sc].severity === 'blocker')) {
              categoryObj[sc].severity = 'warning';
            }
          }
          categoryObj.enabled = newState;
          continue;
        }

        const sc = action;
        const obj = categoryObj[sc];
        const desc = MASTER_SCHEMA[category]?.[sc]?.desc || '';
        
        const enabled = await new Toggle({
          message: `Enable ${pc.yellow(sc)}?` + (desc ? `\n    ${pc.dim('(' + desc + ')')}` : ''),
          initial: obj.enabled !== false
        }).run();

        obj.enabled = enabled;

        if (enabled) {
          // Special handling for structuredData to capture expected @types
          if (category === 'structuredData' && sc === 'expected') {
            const currentTypes = (obj.value || []).map(v => v['@type']).join(', ');
            const typesInput = await new Input({
              message: `  Comma-separated schema types to expect (e.g. Product, BreadcrumbList).\n  Note: schema.org subtypes are covered automatically (e.g. ProductGroup when you select Product):`,
              initial: currentTypes || 'Product'
            }).run();
            
            const types = typesInput.split(',').map(t => t.trim()).filter(Boolean);
            obj.value = types.map(t => ({ '@type': t }));
          }

          // Special handling for blockThirdParty to capture regex patterns
          if (category === 'renderingValidation' && sc === 'blockThirdParty') {
            const currentPatterns = (obj.value || []).join(', ');
            const patternsInput = await new Input({
              message: `  Comma-separated regex patterns to block (e.g. .*googletagmanager\\.com, facebook\\.com, tiktok\\.com):`,
              initial: currentPatterns || ''
            }).run();

            const patterns = patternsInput.split(',').map(p => p.trim()).filter(Boolean);
            obj.value = patterns;
          }

          const severityPrompt = new Select({
            name: 'severity',
            message: `  Severity for ${pc.yellow(sc)}:`,
            choices: ['blocker', 'warning'],
            initial: obj.severity === 'blocker' ? 0 : 1
          });
          obj.severity = await severityPrompt.run();
        }
      }
    }
  }
}

main().catch(err => {
  if (err === '') return; // Enquirer cancel
  console.error(`\n  ${pc.red('Error:')} ${err.message}\n`);
  process.exit(1);
});
