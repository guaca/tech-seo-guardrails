# Automated SEO Guardrails

Playwright-based SEO regression testing — run it locally while you build, or wire it into your CI/CD pipeline to gate every merge. Emulates Googlebot's mobile-first crawl and validates DOM structure against a JSON contract you define.

> [!WARNING]
> **Technical SEO Expertise Recommended**
> 
> Setting up this tool is highly recommended to be done by a **Technical SEO professional** or a **developer supported by an SEO**. 
> 
> Defining a valid "SEO contract" (the expected state of your pages) requires professional judgment to ensure your testing rules align with SEO best practices and your site's specific strategy. 
> 
> To easily set up this contract, tools like **Screaming Frog** are needed to export your current production data as a starting point for the configuration.

---

## What this is

A test framework you add to any project as a dependency. It covers:

- **Crawlability** — robots.txt, HTTP status codes
- **Core metadata** — title, h1, canonical tags, meta robots, meta description, Open Graph, Twitter Cards, hreflang, JSON-LD
- **Rendering quality** — Googlebot two-phase viewport expansion, hidden SEO content, thin content, TTFB
- **Runtime health** — console errors, failed network requests, mixed content
- **Site-wide health** — sitemap validity, broken links, redirect chains, noindex/sitemap conflicts

Tests run with a real Chromium browser using the Googlebot Smartphone user-agent, a 412×732px viewport, and accurate two-phase viewport expansion — the same approach Google uses for mobile-first indexing.

---

## How it works

### Three-tier test pyramid

| Tier | Project | What it does | When |
|---|---|---|---|
| Unit | `unit` | Validates `seo-checks.json` structure without a browser | Local + every CI run |
| Integration | `integration` | Renders each page with Googlebot emulation, checks DOM | Local + every PR |
| E2E | `e2e` | HEAD-requests all sitemap URLs, checks links and redirect chains | Weekly (CI) or on-demand |

### Severity model

Every check has a severity:

- **Blocker** — hard `expect()`. Failing check blocks the PR merge.
- **Warning** — `expect.soft()`. Failure is surfaced in the PR comment for review but doesn't block the merge.

The CI workflow decouples the Playwright exit code from the merge gate: a post-run step reads `test-results/seo-summary.json` and only fails if it contains blocker failures.

---

## Prerequisites

| Requirement | When needed | Notes |
|---|---|---|
| **Node.js 18+** | Always | Required to run Playwright and the setup wizards. |
| **Playwright Browsers** | Always | Run `npx playwright install chromium` after installing the package. |
| **Python 3.10+** | CSV workflow only | Required for `npm run generate` and `npm run init-config`. |
| **questionary** | CSV workflow only | Install via `pip install questionary` for the interactive Python wizard. |

---

## Quick start

### 1. Install

```bash
npm install --save-dev github:guaca/tech-seo-guardrails
npx playwright install chromium
```

### 2. Run the setup wizard

```bash
npx seo-setup
```

The wizard walks you through three steps:

1. **URLs** — sets `PROD_BASE_URL` and `TEST_BASE_URL` in `.env`
2. **SEO contract** — creates `seo-checks.json` (generate from CSV or copy the example)
3. **CI/CD workflows** — optionally generates GitHub Actions workflows in `.github/workflows/` and adds `seo:*` scripts to your `package.json`

Re-run `npx seo-setup` any time to update your URLs or regenerate workflows. Use `npx seo-configure` any time to toggle check groups.

### 3. Create your SEO contract (`seo-checks.json`)

The wizard handles this in Step 2. Two options:

**Generate from CSV (recommended)** — place your CSV in the project folder before running the wizard. The wizard scans for it, lets you pick it, and runs the generator inline. If this is your first run, it also launches the template config wizard first (requires `pip install questionary`).

CSV sources:
- **Screaming Frog** — `Internal tab → Filter by HTML → Export`
- **No Screaming Frog** — fill in `pages.template.csv` with your page URLs, titles, H1s, and canonicals

The generator only includes pages that are **indexable and return a 200 or 304 status code** — non-indexable pages (noindex, canonicalised, etc.) and error/redirect URLs are excluded by default.

**Start from example JSON** — the wizard copies `seo-checks.example.json` for you to edit manually. Good for small sites or quick testing.

See [docs/sf-generator.md](./docs/sf-generator.md) for the full CSV walkthrough and [docs/configuration.md](./docs/configuration.md) for the full field reference.

### Updating your tests as your site evolves

The framework separates your testing **Rules** from your page **Data**. This ensures your test suite remains maintainable even as your site grows.

#### Scenario A: Updating the Rules (Severities and Toggles)
If you want to turn a check off, change a Warning to a Blocker, or enable a new check category across a template:

1.  **Run the configuration utility:**
    ```bash
    npx seo-configure
    ```
2.  **Select your source of truth:**
    -   If you use the **CSV workflow**, select `generator-config.json`. This ensures your new rules are applied every time you regenerate.
    -   If you manage `seo-checks.json` **manually**, select that file to apply changes immediately.
3.  **Regenerate (CSV users only):** If you updated `generator-config.json`, you must run the generator to apply these new rules to your page list:
    ```bash
    npm run seo:generate
    ```

#### Scenario B: Updating the Data (New Pages or Metadata Changes)
If you add new pages to your blog, or the marketing team rewrites titles and H1s:

1.  **Export a fresh CSV** from Screaming Frog (or update your `pages.template.csv`).
2.  **Run the generator:**
    ```bash
    npm run seo:generate
    ```
    *Tip: If you run this without arguments, the script will automatically scan your folder and let you pick your new CSV file from an interactive list.*

This workflow ensures your existing rules (severities, toggles, sample limits) are perfectly preserved while your page list and metadata expectations are refreshed.

### 4. Start your dev server and run tests

```bash
# In one terminal — start your site
npm run dev   # or whatever starts your local server

# In another terminal — run the SEO test suite against it
npx seo-test --project=unit --project=integration

# Full suite (includes E2E sitemap checks — needs a live or staging URL)
npx seo-test

# View results in the browser
npx playwright show-report
```

Run this as often as you like while working on a feature. When you're satisfied, commit — the same tests will run again automatically in CI.

### 5. Testing production directly (No dev server required)

If you are an SEO without local access to the application's dev server, or if you simply want to verify that a recent deployment didn't break anything, you can run the suite directly against the live site. This is also useful for checking aspects not easily covered in a standard CSV crawl (like Googlebot viewport expansion or console errors).

```bash
# Run unit and integration tests against your PROD_BASE_URL
npm run seo:test:prod

# View results
npx playwright show-report
```

Running this command ignores `TEST_BASE_URL` entirely and points Playwright directly at the live production URLs defined in your `seo-checks.json`.

#### Testing without access to the codebase (Standalone mode)

If you are an SEO auditing a site and do not have access to the developer repository, you can still use this framework as an isolated, standalone tool.

1. **Create an empty folder** on your machine and navigate into it:
   ```bash
   mkdir my-seo-audit && cd my-seo-audit
   ```
2. **Initialize a new Node project and install the framework:**
   ```bash
   npm init -y
   npm install --save-dev github:guaca/tech-seo-guardrails
   npx playwright install chromium
   ```
3. **Drop your Screaming Frog CSV** export into this folder.
4. **Run the setup wizard:**
   ```bash
   npx seo-setup
   ```
   *Tip: The wizard will auto-detect your CSV. Since you are only testing production, you can press **Enter** to skip the `TEST_BASE_URL` prompt, and answer **No** when asked to set up GitHub Actions workflows.*
5. **Run the suite against production:**
   ```bash
   npm run seo:test:prod
   ```

---

## Updating (Alpha)

As this project is in **Alpha**, updates to the core logic and CI workflows are frequent. To update to the latest version:

1. **Update the package:**
   ```bash
   npm update github:guaca/tech-seo-guardrails
   ```
2. **Re-sync your workflows and environment:**
   ```bash
   npx seo-setup
   ```
   *(The wizard will automatically detect if your CI workflows are out of sync with the latest templates and prompt you to update them.)*

---

## Configuration files

| File | Required | Description |
|---|---|---|
| `seo-checks.json` | **Yes** | Your site's SEO contract — pages, expected metadata, check config. Generated automatically by the setup wizard from a CSV or copied from an example. |
| `.env` | **Yes** | `PROD_BASE_URL` and `TEST_BASE_URL`. Created by the setup wizard. Never commit this file. |

No `playwright.config.js` changes are needed — `npx seo-test` handles it.

---

## What gets tested

### Per-page integration checks

| Category | Default severity | Key checks |
|---|---|---|
| HTTP response | warning | Status code, X-Robots-Tag, robots.txt, canonical resolution |
| Core metadata | warning | Title, h1, canonical, meta robots, uniqueness, self-reference |
| Meta description | warning | Exact match |
| Open Graph | warning | `og:title`, `og:description`, `og:type`, `og:url`, `og:image` presence |
| Twitter Cards | warning | `twitter:card`, `twitter:title` |
| JSON-LD | warning | Valid JSON, expected `@type`, required fields, and product price validation |
| Images | warning | Alt text, dimensions, LCP image not lazy, no broken images |
| Link health | warning | No empty/js hrefs, internal links not nofollow, noopener on external links |
| Heading hierarchy | warning | No skipped levels, no empty headings |
| HTML fundamentals | warning | charset, viewport, favicon, single `<title>` |
| Rendering validation | blocker¹ | Hidden SEO content, console errors, failed requests, mixed content |
| Mobile usability | warning | Tap target size, font size minimum |
| Server response | warning | TTFB |
| Content quality | warning | Minimum word count |
| Lazy content | configurable | Content visible after Googlebot viewport expansion |

¹ Rendering validation is gated to merge/scheduled lanes by default.

### Site-level checks (integration)

- robots.txt accessible and contains `Sitemap:` directive
- All page titles unique across `seo-checks.json`
- All meta descriptions unique across `seo-checks.json`

### E2E checks (sitemap-driven)

- Sitemap is valid XML, under 50,000 URLs
- All sitemap URLs return 2xx
- No sitemap URLs redirect (redirect in sitemap = stale sitemap)
- No timeouts
- All configured pages appear in the sitemap
- No noindex/sitemap conflicts
- Sample of pages: no broken outbound links
- No redirect chains longer than 2 hops
- Hreflang references are bidirectional

---

## CI/CD

The setup wizard (Step 3) generates GitHub Actions workflows customized for your project — pick your branch names and the wizard writes the files directly into your `.github/workflows/`:

| Workflow | Trigger | Tests | Lane |
|---|---|---|---|
| `seo-merge.yml` | Push to configured branches | Unit + full integration | `merge` |
| `seo-pr.yml` | PR targeting configured branches | Unit + scoped integration | `pr` |
| `seo-scheduled.yml` | Sundays 3am UTC + manual | Unit + integration + E2E | `scheduled` |

You can also run `npm run seo:test:prod` (or `SEO_LANE=production npx seo-test`) to test directly against your live production URL. This uses `PROD_BASE_URL` as the target and skips lane-restricted checks — useful for post-deploy verification or standalone SEO audits.

The wizard also injects `seo:*` npm scripts into your `package.json` so you can run `npm run seo:test` without needing to remember CLI flags.

The PR workflow posts an SEO summary as a PR comment and blocks merge only on blocker failures.

### Providing a server for CI

Integration tests need a live server to connect to. GitHub Actions runners have no running web server by default — you need to provide one. Choose the pattern that fits your stack:

| Your setup | How to provide a server |
|---|---|
| Node / npm project | Add a `webServer` block to your Playwright config — Playwright starts and stops your server automatically |
| Any language with a startable server | Start it as a background process in the workflow (`npm start &`, `python manage.py runserver &`, etc.) and set `TEST_BASE_URL` |
| Persistent staging environment | Add `TEST_BASE_URL` as a repository secret pointing to your staging URL |
| Vercel / Netlify / Render (per-PR previews) | Capture the preview URL from your deploy step and pass it as `TEST_BASE_URL` |

See [docs/ci-integration.md](./docs/ci-integration.md) for step-by-step setup for each pattern, and [docs/environments.md](./docs/environments.md) for all run scenarios.

---

## Docs

| Document | What it covers |
|---|---|
| [docs/sf-generator.md](./docs/sf-generator.md) | Generate `seo-checks.json` from a CSV (Screaming Frog export or `pages.template.csv`) |
| [docs/configuration.md](./docs/configuration.md) | Every field in `seo-checks.json`, with types, defaults, and examples |
| [docs/checks-reference.md](./docs/checks-reference.md) | Every built-in check: what it tests, config options, common failures |
| [docs/adding-checks.md](./docs/adding-checks.md) | How to write a custom check end-to-end (worked example: cookie consent banner) |
| [docs/environments.md](./docs/environments.md) | All run scenarios: localhost, remote preview, GitHub Actions |
| [docs/ci-integration.md](./docs/ci-integration.md) | GitHub Actions setup, `TEST_BASE_URL`/`PROD_BASE_URL`, lanes, merge gate |

---

## Project structure

```
docs/                  # Documentation
bin/
  seo-test.js          # CLI entry point: loads .env, runs Playwright with the built-in config
templates/
  workflows/
    seo-merge.yml       # Template: push workflow (generated by setup wizard)
    seo-pr.yml         # Template: PR workflow (generated by setup wizard)
    seo-scheduled.yml     # Template: weekly workflow (generated by setup wizard)
src/
  index.ts             # Public API: defineSeoConfig(), loadSeoConfig(), type re-exports
  load-config.ts       # Resolves seo-checks.json from consumer's cwd or package root
  config-resolver.ts   # Merges template + page configs, applies lane filter
  config-schema.ts     # Config schema validator: validateConfig(), ValidationError type
  robots-helper.ts     # robots.txt fetching and Googlebot allow/block checking
  sitemap-helper.ts    # Sitemap fetching, URL health checks, link sampling
  reporters/
    seo-summary.ts     # Custom Playwright reporter: groups by severity, writes test-results/seo-summary.md
tests/
  unit/                # Config validation without a browser
  integration/         # Per-page DOM checks with Googlebot emulation
  e2e/                 # Sitemap-driven URL and link health checks
  helpers/
    assertions.ts      # seoExpect(), annotateSeverity(), getSeverity()
    interceptors.ts    # robots.txt enforcement, third-party blocking
    shadow-dom.ts      # deepQueryAll() — DOM traversal through open shadow roots (mirrors Googlebot)
scripts/
  setup.js                   # Setup wizard: .env URLs, seo-checks.json, CI workflows + package.json scripts
  select-tests.sh            # Risk-based test selection for PR lane
  init-generator-config.py   # Wizard: create generator-config.json (pip install questionary)
  generate-from-sf.py        # Generate seo-checks.json from a CSV (SF export or pages.template.csv)
generator-config.example.json  # Template for generator-config.json
pages.template.csv             # Blank CSV template for sites without Screaming Frog
seo-checks.example.json        # Template — copy to seo-checks.json
playwright.config.js           # Googlebot emulation settings, project definitions
```

---

## License

MIT
