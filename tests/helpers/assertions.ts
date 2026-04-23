/**
 * Severity-aware assertion helpers.
 *
 * Blockers use hard expect() — test fails and blocks the build.
 * Warnings use expect.soft() — test logs the failure but doesn't stop execution.
 * The custom reporter groups results by severity so CI can decide what blocks a PR.
 */

import { expect, test } from '@playwright/test';

export type Severity = 'blocker' | 'warning';

/**
 * Returns the appropriate expect function based on severity.
 * - "blocker" → standard expect (fails the test immediately)
 * - "warning" → expect.soft (logs failure but continues)
 */
export function seoExpect(severity: Severity = 'blocker') {
  if (severity === 'warning') {
    return expect.soft;
  }
  return expect;
}

/**
 * Annotates the current test with its severity level.
 * Used by the custom reporter to group results.
 */
export function annotateSeverity(severity: Severity): void {
  test.info().annotations.push({ type: 'severity', description: severity });
}

/**
 * Extracts the severity from a check config object.
 * Falls back to 'warning' if not specified.
 */
export function getSeverity(checkConfig: any): Severity {
  if (checkConfig && typeof checkConfig === 'object' && checkConfig.severity) {
    return checkConfig.severity as Severity;
  }
  return 'warning';
}
