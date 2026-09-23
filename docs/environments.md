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

**Note:** Scenarios 3 and 4 above show the underlying env vars by hand. The workflows `npx seo-setup` actually generates don't hardcode `TEST_BASE_URL` — they resolve it per branch from `seo-environments.json` at run time. See [Scenario 7](#scenario-7-per-branch-environments-shopify-included) for how that works, for Shopify and non-Shopify projects alike.

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

## Scenario 7: Per-branch environments (Shopify included)

CI branches rarely all point at the same place: `main` might be a static host that's already running, a `staging` branch might be a Shopify unpublished preview theme, and a feature branch might need its own local server started in the runner. `seo-environments.json` (generated/edited by `npx seo-setup`, Step 4) maps each branch to one of four **strategies** — Shopify is one of the four, not a separate mode:

```json
{
  "default": { "strategy": "static-url", "url": "https://your-site.com" },
  "branches": {
    "main":      { "strategy": "static-url", "url": "https://your-site.com" },
    "staging":   { "strategy": "shopify-preview", "themeId": "123456789" },
    "feature/*": { "strategy": "start-command", "command": "npm start", "waitUrl": "http://localhost:3000" },
    "qa":        { "strategy": "wait-for-deployment", "waitUrl": "https://qa.your-site.com" }
  }
}
```

- **`static-url`** — a host that's already running (a persistent staging server, or production itself).
- **`shopify-preview`** — Shopify doesn't have a separate staging domain: an "unpublished preview theme" is served on the **same domain** as production, gated by a cookie set when you visit `<domain>/?preview_theme_id=<id>`. This strategy only needs a `themeId` (blank = the live published theme) — the domain is whatever `PROD_BASE_URL`/`TEST_BASE_URL` already is, since Shopify never needs a second host for it.
- **`start-command`** — starts a local server in the runner (`command`) and waits for it (`waitUrl`) before testing.
- **`wait-for-deployment`** — waits for an external deployment to become reachable at `waitUrl`.

Branches are matched exactly first, then by glob pattern (`feature/*`), then `default`.

**How it's resolved:** every generated workflow (`seo-pr.yml`, `seo-merge.yml`) runs `scripts/resolve-branch-environment.js "${{ github.head_ref || github.ref_name }}"` early — `github.head_ref` is the PR's **source** branch (only set for `pull_request` events) and falls back to `github.ref_name` (the pushed-to branch) for merge/scheduled events, so the same expression works in every lane. The script reads `seo-environments.json`, resolves the matching entry, and writes `strategy`/`test_url`/`shopify_theme_id`/`start_command`/`wait_url` as step outputs, which the rest of the job reads: a conditional step starts the local server (or waits for the deployment) only when the resolved strategy calls for it, and `TEST_BASE_URL`/`SHOPIFY_PREVIEW_THEME_ID` in the test-run step come from those outputs instead of a hardcoded value. `seo-scheduled.yml` doesn't use this at all — it always tests `PROD_BASE_URL` directly, with no branch concept.

**A given branch name means something different in each lane, and the wizard asks accordingly.** GitHub's `pull_request` trigger (`branches:` in `seo-pr.yml`) filters by the PR's *target*, not its source — so a PR from `staging` into `main` runs the PR lane exactly like a PR from `dev` into `main` would, and at runtime `head_ref` resolves to whichever of those actually opened the PR. That means the branches you list when the wizard asks "which branch(es) should PRs target" are **not** the ones that need an environment entry — they only decide *when* the PR lane fires. What needs an entry is whatever branch a PR is usually opened **from**, which the wizard asks for separately, once per configured PR target (a PR into `staging` might typically come from `dev`, while a PR into `main` might typically come from `staging` — a git-flow-style chain, each link asked for on its own). The merge lane doesn't have this ambiguity: a push lands *on* the branch, so the branches you list for "which branches trigger SEO tests on MERGE" are exactly the ones that get an environment entry.

**Local development:** the Shopify preview-theme *mechanism* itself (capturing and replaying the cookie) is unrelated to branches — it's controlled by the `SHOPIFY_PREVIEW_THEME_ID` env var, which Step 2 of `npx seo-setup` asks for directly ("Shopify preview theme ID to test locally, blank if not applicable") so you can test one preview theme on your own machine regardless of what any branch is configured to do in CI. Under the hood, a Playwright `globalSetup` step (`scripts/shopify-preview-setup.js`) visits `<baseUrl>/?preview_theme_id=<id>` once before any test runs, captures the cookie Shopify sets, and reuses it for every check afterward — both browser navigation (`page.goto()`) and the raw HTTP requests some checks make directly (robots.txt, sitemap, broken-link and redirect-chain checks). You don't need to know Shopify's actual cookie name or format; the framework lets Shopify set it and just replays it.

**No `seo-environments.json` yet?** The resolver falls back to a single `static-url` strategy built from `TEST_BASE_URL`/`PROD_BASE_URL` for every branch — existing installs keep working unchanged until you opt into per-branch config.

**`SEO_LANE=production` always wins:** the [production lane](#scenario-6-testing-production-directly-manual) is documented to mean "ignore staging config and test the live site directly." If `SHOPIFY_PREVIEW_THEME_ID` is still sitting in your local `.env` from testing a preview theme, running `npm run seo:test:prod` (or any `SEO_LANE=production` run) ignores it and tests the true live theme — the feature never engages under that lane, regardless of what's configured.

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
| `SHOPIFY_PREVIEW_THEME_ID` | No | Shopify only — theme ID of an unpublished preview theme to test locally. In CI, this is resolved per branch from `seo-environments.json` instead. See [Scenario 7](#scenario-7-per-branch-environments-shopify-included). |

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
