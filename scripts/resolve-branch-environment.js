#!/usr/bin/env node
'use strict';

/**
 * Resolves which environment-testing strategy applies to a given branch, from
 * seo-environments.json, and writes the result as GitHub Actions step outputs.
 *
 * Used identically by seo-pr.yml (branch = github.head_ref) and seo-merge.yml
 * (branch = github.ref_name) — one script, one config file, for every lane and
 * every strategy (including Shopify preview themes, which used to be a special
 * fromJSON(...) expression embedded directly in seo-merge.yml). See
 * docs/environments.md for the full model.
 *
 * Falls back to a single static-url strategy built from TEST_BASE_URL/
 * PROD_BASE_URL when seo-environments.json doesn't exist yet, so installs that
 * haven't migrated to per-branch config keep working unchanged.
 */

const fs = require('fs');
const path = require('path');
const { getGuardrailsDir } = require('./wizard-utils');

const VALID_STRATEGIES = ['static-url', 'shopify-preview', 'start-command', 'wait-for-deployment'];

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function findEnvironmentsFile(projectRoot) {
  const candidates = [process.env.SEO_ENVIRONMENTS_PATH, path.join(getGuardrailsDir(projectRoot), 'seo-environments.json')].filter(
    Boolean,
  );
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

/** Exact match first, then the first glob pattern (containing "*") that matches, then "default". */
function resolveEntry(config, branch) {
  const branches = config.branches || {};
  if (Object.prototype.hasOwnProperty.call(branches, branch)) {
    return branches[branch];
  }
  for (const [pattern, entry] of Object.entries(branches)) {
    if (pattern.includes('*') && globToRegExp(pattern).test(branch)) {
      return entry;
    }
  }
  return config.default || null;
}

function validateEntry(entry, source) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Invalid environment entry from ${source}: expected an object.`);
  }
  if (!VALID_STRATEGIES.includes(entry.strategy)) {
    throw new Error(`Invalid strategy "${entry.strategy}" in ${source}. Must be one of: ${VALID_STRATEGIES.join(', ')}`);
  }
}

const EMPTY_RESULT = { test_url: '', shopify_theme_id: '', start_command: '', wait_url: '' };

/**
 * Pure function — takes the project's base URLs explicitly rather than reading
 * process.env itself, so it's fully deterministic and testable without env
 * pollution. main() is what wires up the real environment (see below).
 *
 * @param {string} branch
 * @param {{ projectRoot?: string, prodBaseUrl?: string, testBaseUrl?: string }} [opts]
 */
function resolve(branch, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const prodBaseUrl = opts.prodBaseUrl || '';
  const testBaseUrl = opts.testBaseUrl || '';
  const baseUrl = testBaseUrl || prodBaseUrl;

  const filePath = findEnvironmentsFile(projectRoot);
  if (!filePath) {
    return { strategy: 'static-url', ...EMPTY_RESULT, test_url: baseUrl };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }

  const entry = resolveEntry(config, branch);
  if (!entry) {
    throw new Error(`No environment entry matched branch "${branch}", and no "default" is set in ${filePath}.`);
  }
  validateEntry(entry, filePath);

  switch (entry.strategy) {
    case 'static-url':
      return { strategy: 'static-url', ...EMPTY_RESULT, test_url: entry.url || baseUrl };
    case 'shopify-preview':
      return { strategy: 'shopify-preview', ...EMPTY_RESULT, test_url: baseUrl, shopify_theme_id: entry.themeId || '' };
    case 'start-command':
      return {
        strategy: 'start-command',
        ...EMPTY_RESULT,
        test_url: entry.waitUrl || baseUrl,
        start_command: entry.command || '',
        wait_url: entry.waitUrl || '',
      };
    case 'wait-for-deployment':
      return { strategy: 'wait-for-deployment', ...EMPTY_RESULT, test_url: entry.waitUrl || baseUrl, wait_url: entry.waitUrl || '' };
    default:
      // Unreachable — validateEntry already rejected anything outside VALID_STRATEGIES.
      throw new Error(`Unhandled strategy "${entry.strategy}"`);
  }
}

function main() {
  const branch = process.argv[2];
  if (!branch) {
    console.error('Usage: resolve-branch-environment.js <branchName>');
    process.exit(1);
  }

  const result = resolve(branch, {
    prodBaseUrl: process.env.PROD_BASE_URL,
    testBaseUrl: process.env.TEST_BASE_URL,
  });
  const lines = Object.entries(result)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, lines + '\n');
  } else {
    process.stdout.write(lines + '\n');
  }
  console.error(`[resolve-branch-environment] branch="${branch}" -> strategy=${result.strategy}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[resolve-branch-environment] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { resolve, resolveEntry, globToRegExp, findEnvironmentsFile, VALID_STRATEGIES };
