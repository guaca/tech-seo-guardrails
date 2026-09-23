/**
 * Config Loader
 *
 * Resolves seo-checks.json from the consumer's project (<cwd>/.tech-seo-guardrails/)
 * first, falling back to the package root for cloned-repo usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SeoConfig } from './config-resolver';

/**
 * Returns the consumer's project root (process.cwd()).
 * Used by scripts and reporters to write output files.
 */
export function getProjectRoot(): string {
  return process.cwd();
}

/**
 * Returns the package root (where this npm package lives).
 * Used to locate test files and package assets.
 */
export function getPackageRoot(): string {
  return path.resolve(__dirname, '..');
}

/**
 * All wizard-generated/consumed files (seo-checks.json, generator-config.json,
 * captured Shopify preview state, test output) live under one folder in the
 * consumer's project root — mirrors the .github/workflows/ convention (a
 * dot-folder, fully visible to git/npm/CI; the leading dot only affects
 * default `ls` listing).
 */
export const GUARDRAILS_DIR_NAME = '.tech-seo-guardrails';

export function getGuardrailsDir(root: string = getProjectRoot()): string {
  return path.join(root, GUARDRAILS_DIR_NAME);
}

/**
 * Loads seo-checks.json with the following resolution order:
 *   1. SEO_CONFIG_PATH env var (absolute, or relative to cwd)
 *   2. <cwd>/.tech-seo-guardrails/seo-checks.json  (consumer's project root)
 *   3. <packageRoot>/seo-checks.json  (fallback for cloned-repo usage)
 *
 * Throws with a clear error if not found anywhere.
 */
export function loadSeoConfig(): SeoConfig {
  const candidates: string[] = [];

  // 1. Explicit env var
  if (process.env.SEO_CONFIG_PATH) {
    const explicit = path.isAbsolute(process.env.SEO_CONFIG_PATH)
      ? process.env.SEO_CONFIG_PATH
      : path.resolve(process.cwd(), process.env.SEO_CONFIG_PATH);
    candidates.push(explicit);
  }

  // 2. Consumer's project root
  candidates.push(path.join(getGuardrailsDir(), 'seo-checks.json'));

  // 3. Package root (cloned-repo fallback)
  const pkgRoot = path.join(getPackageRoot(), 'seo-checks.json');
  if (!candidates.includes(pkgRoot)) {
    candidates.push(pkgRoot);
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      try {
        return JSON.parse(raw) as SeoConfig;
      } catch (err) {
        throw new Error(
          `Failed to parse SEO configuration file at "${candidate}".\n` +
          `Check for syntax errors like missing commas or unmatched quotes.\n` +
          `Original error: ${(err as Error).message}`
        );
      }
    }
  }

  throw new Error(
    `Could not find seo-checks.json. Searched:\n` +
      candidates.map((c) => `  - ${c}`).join('\n') +
      `\n\nRun 'npx seo-setup' to create one, or set SEO_CONFIG_PATH.`,
  );
}
