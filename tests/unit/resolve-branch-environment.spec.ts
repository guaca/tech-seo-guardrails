/**
 * Unit Tests: Branch Environment Resolver
 *
 * Pure logic checks for resolve-branch-environment.js's matching + strategy
 * output shape. No GitHub Actions runtime involved — GITHUB_OUTPUT is unset,
 * so resolve() is exercised directly instead of through main().
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Plain CommonJS require — scripts/*.js isn't part of the TS project (no
// allowJs), so this is typed as `any` rather than statically resolved.
const { resolve, resolveEntry, globToRegExp } = require('../../scripts/resolve-branch-environment');

function writeEnvironmentsFile(config: unknown): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-environments-test-'));
  const guardrailsDir = path.join(dir, '.tech-seo-guardrails');
  fs.mkdirSync(guardrailsDir, { recursive: true });
  const filePath = path.join(guardrailsDir, 'seo-environments.json');
  fs.writeFileSync(filePath, JSON.stringify(config), 'utf-8');
  return { dir, path: filePath };
}

test.describe('globToRegExp', () => {
  test('matches a wildcard suffix pattern', () => {
    const re = globToRegExp('feature/*');
    expect(re.test('feature/foo')).toBe(true);
    expect(re.test('feature/')).toBe(true);
    expect(re.test('bugfix/foo')).toBe(false);
  });

  test('escapes regex special characters in the literal part', () => {
    const re = globToRegExp('release/1.2.*');
    expect(re.test('release/1.2.0')).toBe(true);
    expect(re.test('release/1x2.0')).toBe(false);
  });
});

test.describe('resolveEntry', () => {
  test('prefers an exact branch match over a glob', () => {
    const config = {
      default: { strategy: 'static-url', url: 'https://default.example' },
      branches: {
        main: { strategy: 'static-url', url: 'https://main.example' },
        '*': { strategy: 'static-url', url: 'https://wildcard.example' },
      },
    };
    expect(resolveEntry(config, 'main')).toEqual({ strategy: 'static-url', url: 'https://main.example' });
  });

  test('falls back to a glob pattern when no exact match exists', () => {
    const config = {
      branches: { 'feature/*': { strategy: 'start-command', command: 'npm start', waitUrl: 'http://localhost:3000' } },
    };
    expect(resolveEntry(config, 'feature/new-checkout')).toEqual({
      strategy: 'start-command',
      command: 'npm start',
      waitUrl: 'http://localhost:3000',
    });
  });

  test('falls back to "default" when nothing else matches', () => {
    const config = { default: { strategy: 'static-url', url: 'https://default.example' }, branches: {} };
    expect(resolveEntry(config, 'some-random-branch')).toEqual({ strategy: 'static-url', url: 'https://default.example' });
  });

  test('returns null when nothing matches and there is no default', () => {
    expect(resolveEntry({ branches: {} }, 'some-random-branch')).toBeNull();
  });
});

test.describe('resolve', () => {
  let created: string[] = [];

  test.afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to a plain static-url strategy when seo-environments.json does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-environments-missing-'));
    created.push(dir);
    const result = resolve('main', { projectRoot: dir, prodBaseUrl: 'https://prod.example', testBaseUrl: '' });
    expect(result).toEqual({
      strategy: 'static-url',
      test_url: 'https://prod.example',
      shopify_theme_id: '',
      start_command: '',
      wait_url: '',
    });
  });

  test('resolves static-url for an exact branch match', () => {
    const { dir } = writeEnvironmentsFile({ branches: { main: { strategy: 'static-url', url: 'https://main.example' } } });
    created.push(dir);
    const result = resolve('main', { projectRoot: dir });
    expect(result).toEqual({
      strategy: 'static-url',
      test_url: 'https://main.example',
      shopify_theme_id: '',
      start_command: '',
      wait_url: '',
    });
  });

  test('resolves shopify-preview using the global base URL, not a per-branch URL', () => {
    const { dir } = writeEnvironmentsFile({ branches: { staging: { strategy: 'shopify-preview', themeId: '123456789' } } });
    created.push(dir);
    const result = resolve('staging', { projectRoot: dir, prodBaseUrl: 'https://mystore.myshopify.com' });
    expect(result).toEqual({
      strategy: 'shopify-preview',
      test_url: 'https://mystore.myshopify.com',
      shopify_theme_id: '123456789',
      start_command: '',
      wait_url: '',
    });
  });

  test('resolves start-command with its command and wait URL', () => {
    const { dir } = writeEnvironmentsFile({
      branches: { 'feature/*': { strategy: 'start-command', command: 'npm start', waitUrl: 'http://localhost:3000' } },
    });
    created.push(dir);
    const result = resolve('feature/new-checkout', { projectRoot: dir });
    expect(result).toEqual({
      strategy: 'start-command',
      test_url: 'http://localhost:3000',
      shopify_theme_id: '',
      start_command: 'npm start',
      wait_url: 'http://localhost:3000',
    });
  });

  test('resolves wait-for-deployment with its wait URL', () => {
    const { dir } = writeEnvironmentsFile({ branches: { staging: { strategy: 'wait-for-deployment', waitUrl: 'https://staging.example' } } });
    created.push(dir);
    const result = resolve('staging', { projectRoot: dir });
    expect(result).toEqual({
      strategy: 'wait-for-deployment',
      test_url: 'https://staging.example',
      shopify_theme_id: '',
      start_command: '',
      wait_url: 'https://staging.example',
    });
  });

  test('throws when no branch or default entry matches', () => {
    const { dir } = writeEnvironmentsFile({ branches: { main: { strategy: 'static-url', url: 'https://main.example' } } });
    created.push(dir);
    expect(() => resolve('unrelated-branch', { projectRoot: dir })).toThrow(/No environment entry matched/);
  });

  test('throws on an unknown strategy', () => {
    const { dir } = writeEnvironmentsFile({ branches: { main: { strategy: 'teleport' } } });
    created.push(dir);
    expect(() => resolve('main', { projectRoot: dir })).toThrow(/Invalid strategy/);
  });
});
