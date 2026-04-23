# Environments Guide

This guide explains how to configure the test suite for different run contexts: local development, remote preview URLs, and GitHub Actions CI.

---

## The two URL variables

The framework uses two environment variables with distinct roles:

| Variable | Role | Changes per run? |
|---|---|---|
| `TEST_BASE_URL` | Where tests send requests — your dev server, preview URL, or staging deployment | Yes |
| `PROD_BASE_URL` | The canonical production URL — used for canonical matching and internal link classification | No |

**Why two variables?**

When testing against a non-production server (localhost or a preview URL), your pages still render canonical tags pointing to `https://production.com`. The canonical check should validate that value — not compare against `http://localhost:3000`. `PROD_BASE_URL` gives the tests a stable identity reference while `TEST_BASE_URL` directs traffic to wherever the server is running today.

**Fallback chain:**

- Playwright loads pages from: `TEST_BASE_URL` → `PROD_BASE_URL` → `seo-checks.json baseUrl` → `http://localhost:3000`
- Fetch requests (robots.txt, HTTP checks, sitemap): `TEST_BASE_URL` → `seo-checks.json baseUrl`
- Identity checks (canonical matching, internal link detection): `PROD_BASE_URL` → `seo-checks.json baseUrl`

If you set `PROD_BASE_URL` in `seo-checks.json baseUrl`, it acts as the baseline for both — meaning a single-URL setup where `TEST_BASE_URL` is not set just runs tests against production.

---

## Quick setup

```bash
cp .env.example .env
# Edit .env with your values
```

See [`.env.example`](../.env.example) for all available variables.

---

## Scenario 1: Local dev server (most common)

You're running your site locally and want to validate SEO before pushing.

**What to set:**

```bash
TEST_BASE_URL=http://localhost:3000
PROD_BASE_URL=https://your-site.com
SEO_LANE=         # leave empty to run all checks
```

**Steps:**

1. Start your dev server (e.g. `npm run dev`)
2. Run the integration suite:

```bash
npx playwright test --project=unit --project=integration
```

**What to expect:**

- Pages load from `http://localhost:3000`
- Canonical tags are validated against `https://your-site.com/...` — your pages should already render production canonical URLs even in dev mode
- robots.txt and sitemap are fetched from `http://localhost:3000` — make sure your dev server serves them
- Lane-gated checks (e.g. `renderingValidation`) run without restriction when `SEO_LANE` is unset

---

## Scenario 2: Local testing against a remote preview URL

Your team uses branch-based preview deployments (Vercel, Netlify, Render, etc.) and you want to run tests against a preview URL from your machine — without spinning up a local server.

**What to set:**

```bash
TEST_BASE_URL=https://preview-branch-abc.your-deploy.app
PROD_BASE_URL=https://your-site.com
SEO_LANE=merge   # run merge-lane checks too, since this is a real deployment
```

**Steps:**

```bash
npx playwright test --project=unit --project=integration
```

No local server needed. Tests send all requests to the preview URL.

**What to expect:**

- Canonical checks still validate against `PROD_BASE_URL` — your preview deployment should render production canonical URLs
- Console error checks and other merge-lane checks run (since `SEO_LANE=merge`)
- robots.txt and sitemap are fetched from the preview URL

---

## Scenario 3: GitHub Actions — PR with ephemeral preview URL

Deploy a preview for every PR, then run SEO checks against it.

**Workflow pattern:**

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    outputs:
      preview-url: ${{ steps.deploy.outputs.url }}
    steps:
      - uses: actions/checkout@v6
      - name: Deploy to preview
        id: deploy
        # ... your deployment step, which outputs the preview URL

  seo-tests:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npm ci
      - run: npx playwright install chromium --with-deps
      - name: Run SEO tests
        run: npx playwright test --project=unit --project=integration
        env:
          TEST_BASE_URL: ${{ needs.deploy.outputs.preview-url }}
          PROD_BASE_URL: ${{ secrets.PROD_URL }}
          SEO_LANE: pr
```

**What runs:** Unit tests + integration checks scoped by `select-tests.sh` to files that changed.

**What blocks the PR:** Only blocker-severity failures. Warnings appear in the PR comment but don't block merge.

See [ci-integration.md](./ci-integration.md) for the full merge gate setup.

---

## Scenario 4: GitHub Actions — Merge validation

Run the full integration suite after merging to main or deploying to a staging environment.

```yaml
- name: Run SEO tests
  run: npx playwright test --project=unit --project=integration
  env:
    TEST_BASE_URL: ${{ secrets.STAGING_URL }}
    PROD_BASE_URL: ${{ secrets.PROD_URL }}
    SEO_LANE: merge
```

This runs all merge-lane checks including `renderingValidation` (console errors, failed requests, mixed content) which are too slow or noisy for PR feedback.

---

## Scenario 5: GitHub Actions — Weekly production crawl

Run the full suite including E2E sitemap checks against production.

```yaml
- name: Run SEO tests
  run: npx playwright test --project=unit --project=integration --project=e2e
  env:
    PROD_BASE_URL: ${{ secrets.PROD_URL }}
    SEO_LANE: scheduled
```

`TEST_BASE_URL` is intentionally omitted here — E2E tests always use `PROD_BASE_URL` directly (see [E2E and the production constraint](#e2e-and-the-production-constraint) below).

---

## Scenario 6: Testing production directly (Manual)

If you want to run the unit and integration suite against your live site (e.g. to verify CMS changes without a local server), you can use the `production` lane.

**What to set:**

```bash
SEO_LANE=production
PROD_BASE_URL=https://your-site.com
```

**Steps:**

```bash
# Using the helper script (recommended)
npm run seo:test:prod

# Or manually
SEO_LANE=production npx seo-test --project=unit --project=integration
```

**What to expect:**

- `TEST_BASE_URL` is automatically ignored and replaced by `PROD_BASE_URL`
- Unit and integration tests run directly against the live production site
- Only checks with `lane: ["production"]` or no lane restriction will run

---

## E2E and the production constraint

The `e2e` project (`tests/e2e/seo-links.spec.ts`) is **production-only**. It always fetches the sitemap from `PROD_BASE_URL`, regardless of `TEST_BASE_URL`.

**Why:** Sitemaps contain absolute production URLs (`https://your-site.com/about`). All subsequent checks — URL health (HEAD requests), link sampling, redirect chain detection, hreflang validation — run against those URLs. Fetching the sitemap from a preview URL but checking production URLs is inconsistent, and fetching from preview with remapped URLs is beyond the scope of this test tier.

**What this means in practice:**

| Workflow | `TEST_BASE_URL` | `PROD_BASE_URL` | E2E runs against |
|---|---|---|---|
| Local dev / PR / Merge | localhost or preview URL | `https://your-site.com` | *(e2e not run in these lanes)* |
| Scheduled (`SEO_LANE=scheduled`) | *(not needed)* | `https://your-site.com` | `https://your-site.com` ✓ |
| Production (`SEO_LANE=production`) | *(not needed)* | `https://your-site.com` | *(e2e usually skipped here)* |

The `production` lane is primarily intended for fast validation of unit and integration tiers against the live site.

---

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `TEST_BASE_URL` | No | Where tests send requests. Defaults to `PROD_BASE_URL`, then `seo-checks.json baseUrl`, then `http://localhost:3000`. |
| `PROD_BASE_URL` | No* | Canonical production URL for identity checks. Overrides `seo-checks.json baseUrl` if set. |
| `SEO_LANE` | No | Lane filter: `pr`, `merge`, `scheduled`, `production`, or empty (runs all checks). |
| `SEO_SAMPLE_LIMIT` | No | Max pages per template in the integration suite. Overrides `sampleConfig.maxPagesPerTemplate`. Ignored when `SEO_LANE=scheduled`. |

*At least one of `PROD_BASE_URL` or `seo-checks.json baseUrl` must be set.

---

## Page sampling

For large sites with many pages sharing a template (product listings, blog posts), the integration suite can be capped per template using `sampleConfig.maxPagesPerTemplate` in `seo-checks.json` or the `SEO_SAMPLE_LIMIT` env var.

- **PR / merge**: sampling applies — fast feedback on a representative subset
- **Scheduled (`SEO_LANE=scheduled`)**: sampling is disabled — all pages always run
- **E2E**: unaffected — E2E tests use sitemap URLs, not the `pages` array

See [configuration.md](./configuration.md#sampleconfig) for full details.

---

## Relationship with `seo-checks.json baseUrl`

The `baseUrl` field in `seo-checks.json` is the fallback for `PROD_BASE_URL`. If you set `PROD_BASE_URL`, it takes precedence. If you don't, `seo-checks.json baseUrl` is used.

This means `seo-checks.json` can remain self-contained with the production URL — and you override it at runtime via env vars for different environments.
