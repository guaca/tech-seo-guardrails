# Generating seo-checks.json from a CSV

Instead of hand-authoring `seo-checks.json` from scratch, you can generate it from a CSV of your pages. The script fills in expected values (title, canonical, H1, OG tags, etc.) for every page automatically. You then only need to configure which checks to run and at what severity.

**The CSV can come from two places:**

- **Screaming Frog** — run a crawl and export as CSV (Internal tab > Filter by HTML > Export). This is the fastest option if you're already using SF.
- **`pages.template.csv`** — a blank template included in the project. Fill it in manually with your page URLs and metadata if you don't have Screaming Frog.

Both inputs use the same column format and the same generator script.

---

## Overview

The workflow has three steps:

1. **Configure once** — run the interactive wizard to create `generator-config.json` (URL pattern → template mappings + check settings)
2. **Prepare your CSV** — either export from Screaming Frog or fill in `pages.template.csv`
3. **Generate any time** — run the generator script whenever the site changes

---

## Prerequisites

The wizard requires [questionary](https://github.com/tmbo/questionary):

```bash
pip install questionary
```

The generator script (`generate-from-sf.py`) uses Python stdlib only — no extra install needed.

---

## Step 1 — Run the config wizard

If you installed the package as a dependency:
```bash
npx seo-init-config
```

If working in the framework repository:
```bash
npm run init-config
```

The wizard walks you through:

1. **Site basics** — base URL, sitemap path, max crawl URLs
2. **Sampling** — how many pages per template to test (random rotation)
3. **Templates** — one per repeating page type (e.g. `product`, `blog-post`, `category`)
   - The `home` template (`^/$`) is pre-seeded automatically — no need to define it
   - URL pattern (regex matched against path — first match wins)
   - Playwright wait strategy
   - Which checks to enable (multi-select checklist)
   - Severity and thresholds for each enabled check
4. **`other` template** — catch-all for standalone pages not matched above (`/about/`, `/contact/`, `/terms/`, etc.)

The wizard writes `generator-config.json` and launches the Node.js check manager for fine-tuning.

---

## Step 2 — Prepare your CSV

### Option A: Screaming Frog export (recommended if you have it)

In Screaming Frog, configure the crawl to collect the following before exporting:

| Tab | Columns needed |
|---|---|
| Internal HTML | Address, Status Code, Indexability |
| Page Titles | Title 1 |
| Meta Description | Meta Description 1 |
| H1 | H1-1 |
| Canonical | Canonical Link Element 1 |
| Meta Robots | Meta Robots 1 |
| Open Graph | og:title, og:description, og:image, og:type, og:url |
| Twitter Cards | twitter:card, twitter:title, twitter:description, twitter:image |

**Recommended export method:** Go to the `Internal` tab, filter by `HTML`, and click `Export` — this produces a CSV containing all the standard HTML metadata columns.

**Crucial: Extraction Requirements**
By default, Screaming Frog does not include social tags or structured data in its exports.
## Setting up Screaming Frog for full coverage

While basic SEO elements (title, meta description, H1, status code) are extracted automatically, social tags and JSON-LD must be explicitly captured so they land in the "Internal HTML" export tab.

### Required Custom Extractions

You must set up [Custom Extraction](https://www.screamingfrog.co.uk/seo-spider/tutorials/web-scraping/) (**Configuration > Custom > Extraction**) to collect these columns. Set the extractor type to XPath or CSS Path, and set the extraction mode to **Inner HTML** or **Text** depending on the element.

**Open Graph & Twitter Cards:**

- `og:title` — `//meta[@property="og:title"]/@content` (XPath, Extract: Attribute Value)
- `og:description` — `//meta[@property="og:description"]/@content` (XPath, Extract: Attribute Value)
- `og:image` — `//meta[@property="og:image"]/@content` (XPath, Extract: Attribute Value)
- `og:type` — `//meta[@property="og:type"]/@content` (XPath, Extract: Attribute Value)
- `og:url` — `//meta[@property="og:url"]/@content` (XPath, Extract: Attribute Value)
- `twitter:card` — `//meta[@name="twitter:card"]/@content` (XPath, Extract: Attribute Value)
- `twitter:title` — `//meta[@name="twitter:title"]/@content" (XPath, Extract: Attribute Value)
- `twitter:description` — `//meta[@name="twitter:description"]/@content" (XPath, Extract: Attribute Value)
- `twitter:image` — `//meta[@name="twitter:image"]/@content" (XPath, Extract: Attribute Value)

**JSON-LD / Structured Data:**

*Do not rely on the native "Structured Data" extraction feature under Configuration > Spider > Extraction, as it creates separate reports rather than embedding the JSON into the main Internal HTML export.*

Instead, create a Custom Extraction rule:
- **Name:** `JSON-LD` (or `Schema`, `Structured Data`)
- **Path type:** `XPath`
- **Path expression:** `//script[@type="application/ld+json"]`
- **Extract:** `Inner Content` (This ensures the raw `{ ... }` JSON block is captured).

The generator script automatically scans columns containing the words "json", "schema", or "structured data" for valid JSON objects. If it finds a block whose `@type` matches a type you've enabled in your `generator-config.json`, it will import the exact values from the CSV into your `seo-checks.json` contract.

If these columns are missing from your CSV, the generator will simply skip those checks or populate them with default values.

### Option B: Fill in pages.template.csv (no Screaming Frog needed)

Copy the blank template included in the project and fill it in with your page data:

```bash
cp pages.template.csv pages.csv
# Open pages.csv in Excel, Google Sheets, or any spreadsheet app
# Fill in your pages: URL, title, H1, meta description, canonical, etc.
# Use "200" or "304" for Status Code and "Indexable" for Indexability
```

---

## Step 3 — Run the generator

Whenever your site changes (new pages, new H1s, updated meta descriptions), run the generator to refresh your `seo-checks.json` contract.

If installed as a dependency:
```bash
npm run seo:generate
```

If working in the framework repository:
```bash
npm run generate
```

**Interactive Mode:** If you run the command without any arguments, the script will automatically scan your folder for CSV files and let you pick one from an interactive list.

### Advanced options

You can also pass arguments directly to skip the interactive prompt:

```bash
# Explicitly pass the CSV file
npm run seo:generate -- my-crawl.csv

# Write to a draft file first to review before overwriting
npm run seo:generate -- my-crawl.csv --out seo-checks.draft.json

# Include non-indexable pages (e.g. to audit them separately)
npm run seo:generate -- my-crawl.csv --include-noindex
```

| Flag | Default | Description |
|---|---|---|
| `--config PATH` | `generator-config.json` | Path to your rules template |
| `--out PATH` | `seo-checks.json` | Output file path |
| `--base-url URL` | from config | Override `baseUrl` from config |
| `--include-noindex` | off | Include non-indexable pages (skipped by default) |
| `--include-non-200` | off | Include pages with status other than 200 or 304 (skipped by default) |

---

## Re-running after site changes

The framework separates your **Rules** (`generator-config.json`) from your **Data** (`seo-checks.json`).

1.  **To update your rules** (change a severity, turn on a new check category):
    -   Run `npx seo-configure` and select `generator-config.json`.
    -   Run `npm run seo:generate` to apply those rules to your pages.
2.  **To update your page data** (metadata changed on the live site, new URLs added):
    -   Export a fresh CSV.
    -   Run `npm run seo:generate` and select the new CSV.

This ensures you never lose your severities and check toggles when refreshing your site's data.
