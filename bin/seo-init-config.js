#!/usr/bin/env node
/**
 * Wrapper for the Python SEO init-config script
 */
const { spawnSync } = require('child_process');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const pythonScript = path.join(PKG_ROOT, 'scripts', 'init-generator-config.py');

const result = spawnSync('python3', [pythonScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

process.exit(result.status ?? 0);
