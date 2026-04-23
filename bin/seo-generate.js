#!/usr/bin/env node
/**
 * Wrapper for the Python SEO generator script
 */
const { spawnSync } = require('child_process');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const pythonScript = path.join(PKG_ROOT, 'scripts', 'generate-from-sf.py');

const result = spawnSync('python3', [pythonScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

process.exit(result.status ?? 0);
