#!/usr/bin/env node
/**
 * wizard-utils.js — Shared helpers for the interactive setup wizards
 * (setup.js, basic-contract-wizard.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const pc = require('picocolors');

function print(line) {
  process.stdout.write((line ?? '') + '\n');
}

const DIVIDER = pc.gray('─'.repeat(62));

function header(title) {
  print('\n' + DIVIDER);
  print('  ' + pc.bold(pc.white(title)));
  print(DIVIDER);
}

// Custom prompt options to match the cyan/pro aesthetic
const promptOptions = {
  prefix: (state) => state.status === 'submitted' ? pc.cyan(pc.bold('✓')) : pc.cyan(pc.bold('?')),
  symbols: {
    indicator: pc.cyan(pc.bold('❯')),
  }
};

function findCsvFiles(dir, maxDepth = 2, _depth = 0) {
  const results = [];
  if (_depth > maxDepth) return results;
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', 'vendor']);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findCsvFiles(full, maxDepth, _depth + 1));
    else if (entry.name.toLowerCase().endsWith('.csv')) results.push(full);
  }
  return results;
}

/**
 * True when this script is running as an installed dependency of some other
 * project, false when it's running from within a clone of this repo itself.
 *
 * Not `__dirname.includes('node_modules')` — under `npm link` or
 * `npm install <local-path>` (both symlink the package into node_modules),
 * Node resolves __dirname to the symlink's REAL target, which never contains
 * "node_modules". Comparing realpaths is robust to symlinked installs too.
 */
function isInstalledDependency(pkgRoot, cwd = process.cwd()) {
  try {
    return fs.realpathSync(pkgRoot) !== fs.realpathSync(cwd);
  } catch {
    return path.resolve(pkgRoot) !== path.resolve(cwd);
  }
}

module.exports = { print, DIVIDER, header, promptOptions, findCsvFiles, isInstalledDependency };
