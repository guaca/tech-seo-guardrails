# CI Integration

This guide covers how to wire the SEO guardrails into your GitHub Actions pipelines.

---

## The three workflows

The framework ships with three workflow files in `.github/workflows/`. Each targets a different stage of your development process.

### 1. `seo-pr.yml` — PR checks (fast feedback)

**Trigger:** every pull request to `main`

**What runs:** unit tests + integration checks selected by `select-tests.sh` based on changed files

**Shards:** 2 parallel shards

**Lane:** `SEO_LANE=pr`

**Merge gate:** the job posts an SEO summary as a PR comment, then reads `test-results/seo-summary.json` (written by the reporter) to check for blocker failures. If `status` is `"FAILED"`, the job exits with a non-zero code and blocks the merge. Warnings don't block the merge.

This is your main developer-facing feedback loop. It gives targeted, fast results: if only content files changed, only metadata checks run; if template files changed, the full integration suite runs.

### 2. `seo-merge.yml` — Merge validation (complete)

**Trigger:** push to `main` or `staging` branch

**What runs:** unit tests + full integration suite

**Shards:** 4 parallel shards

**Lane:** `SEO_LANE=merge`

This runs the full integration suite including any checks gated to `lane: ["merge"]` (e.g. `renderingValidation` with console error monitoring). Point it at your staging or preview deployment via `TEST_BASE_URL`.

### 3. `seo-scheduled.yml` — Scheduled full crawl

**Trigger:** every Sunday at 3:00 AM UTC (configurable), plus `workflow_dispatch`

**What runs:** unit tests + integration + E2E (sitemap crawl, link health, redirect chains, hreflang)

**Lane:** `SEO_LANE=scheduled`

This workflow acts as the ultimate site-wide health check by executing three projects simultaneously. It relies on **two distinct sources of truth**, which is a critical difference from the PR and Merge lanes:

1. **Integration tests** use the `seo-checks.json` contract. Because it's the `scheduled` lane, the framework bypasses all random sampling limits (`maxPagesPerTemplate`) and runs heavy DOM validation against *every single URL* defined in your JSON contract.
2. **E2E tests** use your live `sitemap.xml`. The framework fetches the sitemap and fires high-speed HEAD requests to thousands of URLs to check for 404s, redirect chains, and timeouts. It does *not* do full DOM rendering here.
3. **The Bridge:** The E2E suite explicitly cross-references these two sources. It verifies that every critical page configured in your `seo-checks.json` actually appears in the live `sitemap.xml`, throwing a blocker if a critical page is missing from indexation signaling.

Running this weekly catches "drift": broken links introduced by CMS edits, sitemap URLs that now redirect, and pages that accidentally dropped out of the sitemap over time. Results are retained for 90 days for trend tracking.

**E2E tests always run against `PROD_BASE_URL`.** Sitemaps contain absolute production URLs — `TEST_BASE_URL` is ignored by the E2E project. Set only `PROD_BASE_URL` for the weekly workflow.

**On failure, a GitHub issue is created automatically.** The issue title is `Scheduled SEO check failed — YYYY-MM-DD` with label `seo-regression`, and includes blocker/warning counts read from `seo-summary.json` plus a direct link to the workflow run. This requires the workflow to have `issues: write` permission (already set in the shipped workflow). No external services or tokens are needed beyond the default `GITHUB_TOKEN`.

---

## Providing a server for CI

Integration tests need a live server to connect to. GitHub Actions runners have no running web server by default. The `npx seo-setup` wizard asks how your environment will be prepared and generates the correct workflow steps automatically:

### 1. Start a local server in the workflow (e.g. npm start)

If you don't have a persistent staging environment or prefer to test the built code locally in CI, the wizard configures the workflow to start a background process and wait for it to respond.

```yaml
- name: Start local server
  run: |
    npm start &
    npx wait-on http://localhost:3000 --timeout 60000
```

### 2. Wait for an external deployment

If your site is hosted on a platform like Vercel, Netlify, or WP Engine, pushing code to GitHub triggers a deployment on their end. The GitHub Action must **wait** for that deployment to finish before running tests, or else it will test the old version of the site.

See [Waiting for external deployments](#waiting-for-external-deployments) below for configuration examples.

### 3. It is already running / No wait needed

If you have a persistent staging environment that is updated out-of-band, or you are running tests manually against a live site, no server setup is needed in CI. The workflow simply points Playwright at the provided `TEST_BASE_URL` and runs immediately.

---

## Waiting for external deployments

If you selected option 2 in the setup wizard, you need to add custom steps to your generated `.github/workflows/seo-*.yml` files to pause the workflow until your external hosting platform finishes deploying.

Here are three common approaches:

### Approach A: Platform-specific Actions (Recommended)

If your host provides a GitHub Action, it often handles the waiting automatically and outputs the fresh preview URL.

**Vercel Example:**
```yaml
- name: Deploy to Vercel
  uses: amondnet/vercel-action@v20
  id: deploy
  with:
    vercel-token: ${{ secrets.VERCEL_TOKEN }}
    vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
    vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}

- name: Run SEO tests
  run: npx playwright test --project=unit --project=integration
  env:
    TEST_BASE_URL: ${{ steps.deploy.outputs.preview-url }}
    PROD_BASE_URL: https://your-site.com
```

### Approach B: Status Checks / Webhooks

For platforms like WP Engine or Kinsta, the deployment might be triggered automatically when you push to a specific branch. You can use a third-party action to pause your workflow until the GitHub "Deployment Status" turns green.

```yaml
- name: Wait for deployment
  uses: lewagon/wait-on-check-action@v1.3.1
  with:
    ref: ${{ github.ref }}
    check-name: 'deploy/wpengine' # The name of the status check your host reports
    repo-token: ${{ secrets.GITHUB_TOKEN }}
    wait-interval: 10
```

### Approach C: Fixed Delay (Simple Fallback)

If your deployments are consistent (e.g. they always take about 45 seconds), the simplest approach is a hardcoded sleep. This is brittle but requires no special tokens or webhooks.

```yaml
- name: Wait for external deployment
  run: sleep 60

- name: Run SEO tests
  run: npx playwright test --project=unit --project=integration
  env:
    TEST_BASE_URL: https://staging.your-site.com
    PROD_BASE_URL: https://your-site.com
```

---

## `TEST_BASE_URL` and `PROD_BASE_URL` — the two URL variables

| Variable | Role |
|---|---|
| `TEST_BASE_URL` | Where Playwright sends requests — your dev server, preview URL, or staging deployment |
| `PROD_BASE_URL` | Your canonical production URL — used for canonical tag matching and internal link classification |

By default, Playwright loads pages from `TEST_BASE_URL`. If not set, it falls back to `PROD_BASE_URL`, then to `http://localhost:3000`.

See [docs/environments.md](./environments.md) for local development scenarios.

---

## `SEO_LANE` and lane filtering

The `SEO_LANE` environment variable controls which lane-gated checks run.

In `seo-checks.json`, any check group with a `lane` array only runs when `SEO_LANE` matches:

```json
"renderingValidation": {
  "lane": ["merge", "scheduled"],
  ...
}
```

| `SEO_LANE` value | What lane-gated checks run |
|---|---|
| `pr` | Only checks with no `lane` restriction |
| `merge` | Checks with `lane: ["merge"]` or `lane: ["merge", "scheduled"]` |
| `scheduled` | Checks with `lane: ["scheduled"]` or `lane: ["merge", "scheduled"]` |
| `production` | Checks with `lane: ["production"]` or no lane restriction |
| unset / empty | All checks run regardless of `lane` (useful locally) |

Use lane filtering to keep PR feedback fast (skip slow or environment-sensitive checks) while still running them in a post-merge or scheduled context.

---

## `select-tests.sh` — risk-based test selection

The PR workflow uses `scripts/select-tests.sh` to select which Playwright projects to run based on what changed. This keeps PR feedback fast when only a subset of files changed.

```yaml
- id: select
  run: |
    ARGS=$(BASE_BRANCH=origin/${{ github.base_ref }} ./scripts/select-tests.sh)
    echo "args=$ARGS" >> "$GITHUB_OUTPUT"
```

### Configuring test triggers

The script uses three arrays at the top of `scripts/select-tests.sh` to define which file paths trigger which tests. **You must customize these arrays to match your project's architecture** (e.g., changing `/locales/` to `/i18n/`, or `/pages/` to `/app/`).

| Array | Tests run | Example paths |
|---|---|---|
| `INTEGRATION_TRIGGERS` | unit + full integration | `seo-checks.json`, `playwright.config.`, `/app/`, `/components/`, `tests/` |
| `RENDERING_TRIGGERS` | unit + integration (rendering checks only, via `--grep=rendering`) | `/styles/`, `/public/`, `.css`, `.scss` |
| `METADATA_TRIGGERS` | unit + integration (metadata checks only, via `--grep=metadata`) | `/content/`, `/locales/`, `/i18n/` |

**Safe Fallback:** If a changed file does not match *any* of the defined triggers, the script defaults to running the **full integration suite** to ensure no regressions slip through.

### How multiple triggers are handled

If a Pull Request touches multiple types of files, the script intelligently combines the triggers:

- **Rendering + Metadata:** If a PR touches both a CSS file and a translation file, the script outputs `--project=integration --grep=rendering|metadata`. Playwright will run all tests tagged with `[rendering]` OR `[metadata]`, skipping the rest.
- **Any Core File:** If a PR touches a CSS file, a translation file, *and* a core routing component (an `INTEGRATION_TRIGGER`), the script drops the grep filters entirely and runs the **full integration suite**.

### Overriding the base branch

By default `select-tests.sh` diffs against `origin/main`. Override for non-standard trunk names:

```bash
BASE_BRANCH=origin/develop ./scripts/select-tests.sh
```

In GitHub Actions, pass the PR base ref dynamically (already shown in the workflow snippet above):
```yaml
ARGS=$(BASE_BRANCH=origin/${{ github.base_ref }} ./scripts/select-tests.sh)
```

---

## The blocker merge gate

The PR workflow's merge gate works like this:

```yaml
- name: Run SEO tests (shard ${{ matrix.shard }}/2)
  run: npx playwright test ... --reporter=blob
  continue-on-error: true   # ← warnings don't block the job
  env:
    SEO_LANE: pr

- name: Fail if blocker failures found
  run: |
    if [ ! -f test-results/seo-summary.json ]; then
      echo "⚠️  seo-summary.json not found — reporter may have failed. Treating as failure."
      exit 1
    fi
    STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('test-results/seo-summary.json','utf-8')).status)")
    if [ "$STATUS" = "FAILED" ]; then
      echo "❌ Blocker failures detected — merge is blocked."
      exit 1
    else
      echo "✅ No blocker failures."
    fi
```

`continue-on-error: true` decouples the Playwright process exit code (which is non-zero whenever any `expect.soft` warning fires) from the job status. The job only fails at the JSON check step, which reads `seo-summary.json` and exits non-zero if `status === "FAILED"`.

### The SEO summary report

After shards complete, the merge-reports job combines blob reports and runs the custom reporter (`src/reporters/seo-summary.ts`), which writes two files:

- **`test-results/seo-summary.md`** — human-readable report posted as a PR comment. Groups results into Blockers (hard failures) and Warnings (soft failures).
- **`test-results/seo-summary.json`** — machine-readable result for CI consumption: `{ "blockers": N, "warnings": N, "total": N, "status": "FAILED"|"PASSED" }`. The merge gate reads this instead of grepping the markdown, making it immune to formatting changes.

Both files are uploaded as artifacts (retained for 14 days on PR runs, 30 days on weekly runs).

If the reporter itself crashes or fails to write the files (e.g. disk full), the merge gate detects the missing `test-results/seo-summary.json` and fails the job with a clear error message rather than silently passing.

---

## Adding the PR comment to your repository

The PR comment step uses `actions/github-script`:

```yaml
- name: Post PR comment with summary
  if: github.event_name == 'pull_request'
  uses: actions/github-script@v8
  with:
    script: |
      const fs = require('fs');
      const summary = fs.existsSync('test-results/seo-summary.md')
        ? fs.readFileSync('test-results/seo-summary.md', 'utf-8')
        : 'SEO summary report not available.';
      github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: summary,
      });
```

This requires the `GITHUB_TOKEN` that GitHub Actions injects automatically — no additional secrets needed. If your repository has a restrictive permissions policy, ensure the workflow has `pull-requests: write` permission:

```yaml
permissions:
  contents: read
  pull-requests: write
```

---

## Local development

Run the full suite locally against a running dev server:

```bash
# Terminal 1: start your dev server
npm run dev

# Terminal 2: run SEO tests
TEST_BASE_URL=http://localhost:3000 npx playwright test

# Integration only (faster)
TEST_BASE_URL=http://localhost:3000 npx playwright test --project=unit --project=integration

# With a specific lane (to test staging-gated checks)
TEST_BASE_URL=http://localhost:3000 SEO_LANE=merge npx playwright test --project=integration

# Open the HTML report after a run
npx playwright show-report
```

### Filtering by check category

All test names start with a category tag in square brackets. Use `--grep` to run a subset:

```bash
# Only metadata checks
npx playwright test --grep "\[metadata\]"

# Only rendering checks
npx playwright test --grep "\[rendering\]"

# Only HTTP checks
npx playwright test --grep "\[http\]"
```

---

## Timeout and shard configuration

| Workflow | Timeout | Shards |
|---|---|---|
| PR | 5 minutes | 2 |
| Merge | 10 minutes | 4 |
| Scheduled | 30 minutes | 1 (no sharding) |

For large sites with many pages, increase shards and `crawlConfig.maxUrls`. For a 2000-page site, 4 shards on merge and `maxUrls: 2000` with `concurrency: 20` is a reasonable starting point.
