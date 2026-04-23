// @ts-check
'use strict';

/**
 * SEO Summary Reporter
 *
 * Custom Playwright reporter that groups test results by severity (blocker/warning)
 * and outputs a markdown summary. Can be used to post PR comments or generate reports.
 *
 * Usage in playwright.config.js:
 *   reporter: [['./src/reporters/seo-summary.js']]
 */

const fs = require('fs');
const path = require('path');

class SeoSummaryReporter {
  constructor(options) {
    this.results = [];
    this.outputPath = (options && options.outputPath) || path.join(process.cwd(), 'test-results', 'seo-summary.md');
  }

  onTestEnd(test, result) {
    const severityAnnotation = result.annotations && result.annotations.find((a) => a.type === 'severity');
    const severity = (severityAnnotation && severityAnnotation.description) || 'unknown';

    const describeTitle = test.parent ? test.parent.title : '';
    const pageMatch = describeTitle.match(/\((\/.+?)\)\s*$/);
    const pagePath = pageMatch ? pageMatch[1] : null;
    const pageDescription = pageMatch
      ? describeTitle.replace(/^SEO checks for:\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim()
      : null;

    this.results.push({
      title: test.title,
      status: result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed',
      severity,
      duration: result.duration,
      error: result.errors && result.errors[0] && result.errors[0].message && result.errors[0].message.substring(0, 500),
      pagePath,
      pageDescription,
    });
  }

  onEnd(_result) {
    const blockers = this.results.filter((r) => r.severity === 'blocker');
    const warnings = this.results.filter((r) => r.severity === 'warning');
    const others = this.results.filter((r) => r.severity === 'unknown');

    const blockersFailed = blockers.filter((r) => r.status === 'failed');
    const warningsFailed = warnings.filter((r) => r.status === 'failed');
    
    const blockersSkipped = blockers.filter((r) => r.status === 'skipped');
    const warningsSkipped = warnings.filter((r) => r.status === 'skipped');
    const othersSkipped = others.filter((r) => r.status === 'skipped');

    const lines = [
      '# SEO Test Summary',
      '',
      `| Category | Passed | Failed | Skipped | Total |`,
      `|----------|--------|--------|---------|-------|`,
      `| Blockers | ${blockers.filter(r => r.status === 'passed').length} | ${blockersFailed.length} | ${blockersSkipped.length} | ${blockers.length} |`,
      `| Warnings | ${warnings.filter(r => r.status === 'passed').length} | ${warningsFailed.length} | ${warningsSkipped.length} | ${warnings.length} |`,
      `| Other    | ${others.filter(r => r.status === 'passed').length} | ${others.filter(r => r.status === 'failed').length} | ${othersSkipped.length} | ${others.length} |`,
      '',
    ];

    if (blockersFailed.length > 0) {
      lines.push('## Blockers (build-breaking)', '');
      for (const r of blockersFailed) {
        lines.push(`- **FAIL** ${r.title}`);
        if (r.error) lines.push(`  > ${r.error}`);
      }
      lines.push('');
    }

    if (warningsFailed.length > 0) {
      lines.push('## Warnings (non-blocking)', '');
      for (const r of warningsFailed) {
        lines.push(`- **WARN** ${r.title}`);
        if (r.error) lines.push(`  > ${r.error}`);
      }
      lines.push('');
    }

    const hasBlockerFailures = blockersFailed.length > 0;
    lines.push(
      '---',
      '',
      hasBlockerFailures
        ? `**Result: FAILED** — ${blockersFailed.length} blocker(s) must be fixed before merging.`
        : warningsFailed.length > 0
          ? `**Result: PASSED with warnings** — ${warningsFailed.length} warning(s) should be reviewed.`
          : '**Result: ALL PASSED**',
    );

    const markdown = lines.join('\n');

    // Write report files — throw on failure so CI gate exits non-zero
    try {
      const outputDir = path.dirname(this.outputPath);
      if (outputDir !== '.') fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(this.outputPath, markdown, 'utf-8');

      const resultPath = this.outputPath.replace(/\.md$/, '.json');
      const resultData = {
        blockers: blockersFailed.length,
        warnings: warningsFailed.length,
        total: this.results.length,
        status: hasBlockerFailures ? 'FAILED' : 'PASSED',
      };
      fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2), 'utf-8');

      // Write a timestamped copy for local history (non-fatal if it fails)
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const historyDir = path.join(path.dirname(this.outputPath), 'history');
        fs.mkdirSync(historyDir, { recursive: true });
        fs.writeFileSync(path.join(historyDir, `seo-summary-${ts}.md`), markdown, 'utf-8');
        fs.writeFileSync(path.join(historyDir, `seo-summary-${ts}.json`), JSON.stringify(resultData, null, 2), 'utf-8');
      } catch (err) {
        // History writes are best-effort — don't fail the run
        console.warn(`[seo-summary] Warning: Could not write local history files. ${err.message}`);
      }
    } catch (err) {
      console.error(`[seo-summary] FATAL: could not write report files. The CI merge gate depends on these files.`);
      throw err;
    }

    // Also print to stdout
    console.log('\n' + markdown);
  }
}

module.exports = SeoSummaryReporter;
