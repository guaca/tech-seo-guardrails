#!/usr/bin/env node
/**
 * basic-contract-wizard.js — Generates a minimal "Basic" seo-checks.json.
 *
 * Unlike the Custom flow (CSV crawl + per-page exact values), Basic mode asks
 * six yes/no questions ("does every page have a title with content?", etc.)
 * and produces a single shared template applied to every page — existence /
 * minimum-length checks (`mode: "basic"`), not exact-value checks.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Select, Input, Toggle } = require('enquirer');
const pc = require('picocolors');
const { print, header, promptOptions, findCsvFiles } = require('./wizard-utils');

const BASIC_CHECKS = [
  {
    key: 'title',
    label: 'Title tag',
    desc: 'Exactly one <title> exists and has content',
    hasMinLength: true,
    defaultMinLength: 10,
  },
  {
    key: 'metaDescription',
    label: 'Meta description',
    desc: 'Exactly one <meta name="description"> exists and has content',
    hasMinLength: true,
    defaultMinLength: 50,
  },
  {
    key: 'h1',
    label: 'H1',
    desc: 'Exactly one <h1> exists and has content',
    hasMinLength: true,
    defaultMinLength: 1,
  },
  {
    key: 'indexable',
    label: 'Indexability',
    desc: 'No "noindex" in meta robots or the X-Robots-Tag header',
    hasMinLength: false,
  },
  {
    key: 'hreflang',
    label: 'Hreflang',
    desc: 'Page has reciprocal hreflang tags (at least 2: self-reference + 1 alternate)',
    hasMinLength: false,
  },
  {
    key: 'canonical',
    label: 'Canonical',
    desc: '<link rel="canonical"> exists and is not empty',
    hasMinLength: false,
  },
];

const MAX_PAGES = 500;

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function extractUrlsFromCsv(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headerRow = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let colIdx = headerRow.findIndex((h) => ['address', 'url', 'loc', 'page', 'path'].includes(h));
  if (colIdx === -1) colIdx = 0;
  const urls = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const val = (fields[colIdx] || '').trim();
    if (val) urls.push(val);
  }
  return urls;
}

function toRelativePath(urlOrPath) {
  if (!urlOrPath) return null;
  if (urlOrPath.startsWith('/')) return urlOrPath.split('#')[0];
  try {
    const u = new URL(urlOrPath);
    return (u.pathname + u.search).split('#')[0] || '/';
  } catch {
    return null;
  }
}

function normalizeAndDedupe(paths) {
  const seen = new Set();
  const out = [];
  for (const raw of paths) {
    const p = toRelativePath(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, MAX_PAGES);
}

function describePage(p) {
  return p === '/' ? 'Home page' : p;
}

async function resolvePagesFromSitemap(prodUrl, pkgRoot) {
  const { fetchSitemap } = require(path.join(pkgRoot, 'src', 'sitemap-helper'));
  const sitemapUrlPrompt = new Input({
    message: 'Sitemap URL',
    initial: `${prodUrl.replace(/\/$/, '')}/sitemap.xml`,
    ...promptOptions,
  });
  const sitemapUrl = await sitemapUrlPrompt.run();

  print(`\n  ${pc.gray('Crawling ' + sitemapUrl + '...')}`);
  const result = await fetchSitemap(sitemapUrl);
  if (!result.isValid && result.urls.length === 0) {
    print(`\n  ${pc.red('!')} Could not read the sitemap: ${result.errors.join('; ')}`);
    return null;
  }
  if (result.errors.length > 0) {
    print(`  ${pc.yellow('!')} ${result.errors.join('; ')}`);
  }
  const paths = normalizeAndDedupe(result.urls.map((u) => u.loc));
  print(`  ${pc.cyan('✓')} ${paths.length} pages found${result.urlCount > paths.length ? ` (of ${result.urlCount}, capped at ${MAX_PAGES})` : ''}.`);
  return paths;
}

async function resolvePagesManually() {
  const pathsPrompt = new Input({
    message: 'Comma-separated paths (e.g. /, /about, /contact)',
    initial: '/',
    ...promptOptions,
  });
  const raw = await pathsPrompt.run();
  const paths = normalizeAndDedupe(raw.split(',').map((s) => s.trim()));
  if (paths.length === 0) {
    print(`\n  ${pc.red('!')} No valid path was entered.`);
    return null;
  }
  return paths;
}

async function resolvePagesFromCsv(projectRoot, prodUrl) {
  const csvFiles = findCsvFiles(projectRoot);
  if (csvFiles.length === 0) {
    print(`\n  ${pc.yellow('!')} No CSV files found in the project.`);
    return null;
  }
  const csvPrompt = new Select({
    message: 'Select a CSV (must have an Address/URL column):',
    choices: csvFiles.map((f) => ({ name: f, message: path.relative(projectRoot, f) })),
    ...promptOptions,
  });
  const selectedCsv = await csvPrompt.run();
  const urls = extractUrlsFromCsv(selectedCsv);
  const paths = normalizeAndDedupe(urls);
  if (paths.length === 0) {
    print(`\n  ${pc.red('!')} No URLs found in the CSV.`);
    return null;
  }
  print(`  ${pc.cyan('✓')} ${paths.length} pages extracted from the CSV.`);
  return paths;
}

async function resolvePages({ projectRoot, pkgRoot, prodUrl, existingPages }) {
  const choices = [
    { name: 'sitemap', message: 'Auto-crawl from sitemap.xml (Recommended)' },
    { name: 'manual', message: 'Paste a list of paths by hand' },
    { name: 'csv', message: 'Upload a CSV with a URL column' },
  ];
  if (existingPages && existingPages.length > 0) {
    choices.unshift({ name: 'keep', message: `Keep the current ${existingPages.length} pages` });
  }

  const sourcePrompt = new Select({
    message: 'How would you like to select the pages to test?',
    choices,
    ...promptOptions,
  });
  const source = await sourcePrompt.run();

  if (source === 'keep') return existingPages;
  if (source === 'sitemap') return resolvePagesFromSitemap(prodUrl, pkgRoot);
  if (source === 'manual') return resolvePagesManually();
  if (source === 'csv') return resolvePagesFromCsv(projectRoot, prodUrl);
  return null;
}

function existingCheckFor(existingConfig, key) {
  const seo = existingConfig?.templates?.all?.seo;
  if (!seo) return null;
  if (key === 'indexable') return seo.metadata?.metaRobots || null;
  if (key === 'canonical') return seo.metadata?.canonical || null;
  if (key === 'hreflang') return seo.metadata?.hreflang || null;
  return seo.metadata?.[key] || null;
}

async function configureChecks(existingConfig) {
  const results = {};
  print('');
  for (const check of BASIC_CHECKS) {
    const existing = existingCheckFor(existingConfig, check.key);
    const enabledPrompt = new Toggle({
      message: `${pc.bold(check.label)}: ${pc.dim(check.desc)}\n  Enable this check?`,
      initial: existing ? existing.enabled !== false : true,
    });
    const enabled = await enabledPrompt.run();

    if (!enabled) {
      results[check.key] = { enabled: false };
      continue;
    }

    const severityPrompt = new Select({
      message: `  Severity for ${pc.yellow(check.label)}:`,
      choices: ['blocker', 'warning'],
      initial: existing?.severity === 'blocker' ? 0 : 1,
      ...promptOptions,
    });
    const severity = await severityPrompt.run();

    let minLength;
    if (check.hasMinLength) {
      const minLengthPrompt = new Input({
        message: `  Minimum character length for ${pc.yellow(check.label)}`,
        initial: String(existing?.minLength ?? check.defaultMinLength),
        ...promptOptions,
      });
      const raw = await minLengthPrompt.run();
      minLength = Math.max(0, parseInt(raw, 10) || 0);
    }

    results[check.key] = { enabled: true, severity, minLength };
  }
  return results;
}

function buildTemplateSeo(results) {
  const metadata = {};
  const httpChecks = {};

  const put = (obj, key, r) => {
    if (!r.enabled) return;
    const check = { enabled: true, severity: r.severity, mode: 'basic' };
    if (r.minLength !== undefined) check.minLength = r.minLength;
    obj[key] = check;
  };

  put(metadata, 'title', results.title);
  put(metadata, 'metaDescription', results.metaDescription);
  put(metadata, 'h1', results.h1);
  put(metadata, 'canonical', results.canonical);
  put(metadata, 'hreflang', results.hreflang);
  if (results.indexable.enabled) {
    put(metadata, 'metaRobots', results.indexable);
    put(httpChecks, 'xRobotsTag', results.indexable);
  }

  const seo = {};
  if (Object.keys(metadata).length > 0) seo.metadata = metadata;
  if (Object.keys(httpChecks).length > 0) seo.httpChecks = httpChecks;
  return seo;
}

async function runBasicContractWizard({
  projectRoot,
  pkgRoot,
  configPath,
  prodUrl,
  waitForReady,
  sampleLimit,
  existingConfig,
}) {
  header('Basic SEO Contract');
  print('');
  print('  A simple contract: 6 existence/minimum-content checks applied to all your pages.');
  print(pc.gray('  A good first step before building a more detailed Custom contract.'));
  print('');

  const existingPages = existingConfig?.pages?.map((p) => p.path) || null;
  const pages = await resolvePages({ projectRoot, pkgRoot, prodUrl, existingPages });
  if (!pages || pages.length === 0) {
    print(`\n  ${pc.red('!')} Could not build the page list. Setup cancelled.`);
    return false;
  }

  const results = await configureChecks(existingConfig);
  const enabledCount = Object.values(results).filter((r) => r.enabled).length;
  if (enabledCount === 0) {
    print(`\n  ${pc.yellow('!')} No check was enabled. Setup cancelled.`);
    return false;
  }

  const seo = buildTemplateSeo(results);

  const config = {
    baseUrl: prodUrl,
    contractMode: 'basic',
    sampleConfig: {
      maxPagesPerTemplate: Number(sampleLimit) > 0 ? Number(sampleLimit) : 5,
    },
    templates: {
      all: {
        urlPattern: '.*',
        waitForReady,
        seo,
      },
    },
    pages: pages.map((p) => ({ path: p, template: 'all', description: describePage(p) })),
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  print(`\n  ${pc.cyan('✓')}  seo-checks.json generated (Basic mode) with ${pages.length} pages and ${enabledCount} active checks.`);
  return true;
}

module.exports = {
  runBasicContractWizard,
  BASIC_CHECKS,
  // Exported for unit testing — pure, deterministic helpers.
  normalizeAndDedupe,
  toRelativePath,
  buildTemplateSeo,
  describePage,
  extractUrlsFromCsv,
  parseCsvLine,
};
