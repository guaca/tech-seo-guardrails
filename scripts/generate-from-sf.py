#!/usr/bin/env python3
"""
generate-from-sf.py — Generate seo-checks.json from a CSV export.

Compatible with Screaming Frog 'All Tabs' exports or any CSV using the
supported column format (see pages.template.csv for a blank template).

Usage:
    python scripts/generate-from-sf.py crawl-export.csv
    python scripts/generate-from-sf.py crawl-export.csv --config generator-config.json --out seo-checks.json
    python scripts/generate-from-sf.py crawl-export.csv --include-noindex --include-non-200

Required CSV columns:
    Address, Status Code, Indexability
    Title 1, Meta Description 1
    H1-1, H2-1, H2-2, H2-3
    Canonical Link Element 1, Meta Robots 1
    og:title, og:description, og:image, og:type, og:url
    twitter:card, twitter:title, twitter:description, twitter:image
"""

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# Schema.org subtype relationships — when the template expects a base type,
# also accept known subtypes found in real-world CMS exports.
# e.g. Shopify uses ProductGroup for products with variants, which is a
# schema.org subtype of Product.
# ---------------------------------------------------------------------------
SCHEMA_SUBTYPES: dict[str, set[str]] = {
    "Product": {"Product", "ProductGroup", "IndividualProduct"},
}

# ---------------------------------------------------------------------------
# Column name aliases — Screaming Frog column names vary slightly across
# versions and export types. Keys are normalised (lower, stripped).
# ---------------------------------------------------------------------------
COLUMN_ALIASES = {
    # URL
    "address": "address",
    "url": "address",
    # Status
    "status code": "status_code",
    "status": "status_code",
    # Indexability
    "indexability": "indexability",
    "indexability status": "indexability",
    # Title
    "title 1": "title",
    "title": "title",
    "page title": "title",
    # Meta description
    "meta description 1": "meta_description",
    "meta description": "meta_description",
    # H1
    "h1-1": "h1",
    "h1 1": "h1",
    "h1": "h1",
    # H2 (up to 5)
    "h2-1": "h2_1",
    "h2 1": "h2_1",
    "h2-2": "h2_2",
    "h2 2": "h2_2",
    "h2-3": "h2_3",
    "h2 3": "h2_3",
    "h2-4": "h2_4",
    "h2 4": "h2_4",
    "h2-5": "h2_5",
    "h2 5": "h2_5",
    # Canonical
    "canonical link element 1": "canonical",
    "canonical link element": "canonical",
    "canonical": "canonical",
    # Meta robots
    "meta robots 1": "meta_robots",
    "meta robots": "meta_robots",
    # OG tags
    "og:title": "og_title",
    "og title": "og_title",
    "og:description": "og_description",
    "og description": "og_description",
    "og:image": "og_image",
    "og image": "og_image",
    "og:type": "og_type",
    "og type": "og_type",
    "og:url": "og_url",
    "og url": "og_url",
    # Twitter card tags
    "twitter:card": "twitter_card",
    "twitter card": "twitter_card",
    "twitter:title": "twitter_title",
    "twitter title": "twitter_title",
    "twitter:description": "twitter_description",
    "twitter description": "twitter_description",
    "twitter:image": "twitter_image",
    "twitter image": "twitter_image",
}


def normalise_key(name: str) -> str:
    return name.strip().lower()


def build_column_map(headers: list[str]) -> dict[str, int]:
    """Return a mapping of canonical field name → column index."""
    col_map: dict[str, int] = {}
    for i, header in enumerate(headers):
        alias = COLUMN_ALIASES.get(normalise_key(header))
        if alias and alias not in col_map:
            col_map[alias] = i
    return col_map


def get(row: list[str], col_map: dict[str, int], field: str) -> str:
    idx = col_map.get(field)
    if idx is None or idx >= len(row):
        return ""
    return row[idx].strip()


def strip_base_url(url: str, base_url: str) -> str | None:
    """Return the relative path for a URL, stripping base_url if present."""
    u = url.strip()
    if not u:
        return None

    if base_url:
        base = base_url.strip().rstrip("/")
        if u.startswith(base):
            path = u[len(base):]
            if not path:
                return "/"
            # Ensure leading slash and remove trailing slash for normalization
            return "/" + path.lstrip("/").rstrip("/") or "/"

    # Fallback: use urllib to extract the path safely
    try:
        parsed = urlparse(u)
        # Handle protocol-relative URLs (//site.com/path)
        if u.startswith("//") and not parsed.netloc:
            # urlparse needs a scheme to identify netloc for // URLs
            parsed = urlparse("https:" + u)
        
        path = parsed.path
        if not path:
            return "/"
        return "/" + path.lstrip("/").rstrip("/") or "/"
    except Exception:
        return "/" + u.lstrip("/") or "/"


def match_template(path: str, template_order: list[str], templates_cfg: dict) -> str:
    """Return the first template whose urlPattern matches path."""
    for name in template_order:
        pattern = templates_cfg[name].get("urlPattern", ".*")
        if re.search(pattern, path):
            return name
    # Unreachable when the catch-all ("other", pattern ".*") is in template_order,
    # but kept as a safety fallback.
    return template_order[-1] if template_order else "other"


def build_checks_for_template(checks_cfg: dict) -> dict:
    """Return a clean seo object in Strict Object Schema."""
    return {k: v for k, v in checks_cfg.items() if not k.startswith("_")}


def build_og_tags(row: list[str], col_map: dict, og_cfg: dict) -> dict | None:
    if not og_cfg:
        return None

    title = get(row, col_map, "og_title")
    desc = get(row, col_map, "og_description")
    image = get(row, col_map, "og_image")
    og_type = get(row, col_map, "og_type")
    og_url = get(row, col_map, "og_url")

    tags = {}
    if title:
        tags["og:title"] = title
    if desc:
        tags["og:description"] = desc
    if image:
        tags["og:image"] = image
    if og_type:
        tags["og:type"] = og_type
    if og_url:
        tags["og:url"] = og_url

    # Get severity from the template config (which is already in strict object schema)
    # or fallback to "warning"
    tags_cfg = og_cfg.get("tags", {})
    severity = tags_cfg.get("severity", "warning")
    tags_enabled = tags_cfg.get("enabled", False)
    
    # If no tags found in CSV, fallback to template value (if any)
    if not tags:
        tags = tags_cfg.get("value", {})

    require_image_cfg = og_cfg.get("requireImage", {})
    require_image_severity = require_image_cfg.get("severity", severity)
    require_image_enabled = require_image_cfg.get("enabled", False)

    return {
        "tags": {"enabled": tags_enabled, "severity": severity, "value": tags},
        "requireImage": {"enabled": require_image_enabled, "severity": require_image_severity, "value": True}
    }


def build_twitter_cards(row: list[str], col_map: dict, tw_cfg: dict) -> dict | None:
    if not tw_cfg:
        return None

    card = get(row, col_map, "twitter_card")
    title = get(row, col_map, "twitter_title")
    desc = get(row, col_map, "twitter_description")
    image = get(row, col_map, "twitter_image")

    tags = {}
    if card:
        tags["twitter:card"] = card
    if title:
        tags["twitter:title"] = title
    if desc:
        tags["twitter:description"] = desc
    if image:
        tags["twitter:image"] = image

    tags_cfg = tw_cfg.get("tags", {})
    severity = tags_cfg.get("severity", "warning")
    tags_enabled = tags_cfg.get("enabled", False)
    
    # Fallback to template value if CSV is empty
    if not tags:
        tags = tags_cfg.get("value", {})

    return {"tags": {"enabled": tags_enabled, "severity": severity, "value": tags}}


def build_structured_data(row: list[str], headers: list[str], sd_cfg: dict) -> dict | None:
    if not sd_cfg:
        return None

    expected_cfg = sd_cfg.get("expected", {})
    expected_value = expected_cfg.get("value", [])
    if not isinstance(expected_value, list):
        return sd_cfg

    expected_types = [e.get("@type") for e in expected_value if isinstance(e, dict) and "@type" in e]
    if not expected_types:
        return sd_cfg

    found_blocks = []
    # Identify columns that might contain JSON-LD
    for i, header in enumerate(headers):
        if i >= len(row):
            continue
        h_norm = header.lower().strip()
        # Look for columns named JSON-LD, Schema, or Structured Data (common in SF custom extraction)
        if "json-ld" in h_norm or "schema" in h_norm or "structured data" in h_norm:
            cell_val = row[i].strip()
            if not ((cell_val.startswith("{") and cell_val.endswith("}")) or (cell_val.startswith("[") and cell_val.endswith("]"))):
                continue
            
            try:
                data = json.loads(cell_val)
                
                blocks_to_check = []
                if isinstance(data, dict):
                    if "@graph" in data and isinstance(data["@graph"], list):
                        blocks_to_check.extend(data["@graph"])
                    else:
                        blocks_to_check.append(data)
                elif isinstance(data, list):
                    blocks_to_check.extend(data)
                else:
                    continue
                
                for block in blocks_to_check:
                    if not isinstance(block, dict):
                        continue
                    
                    data_types = block.get("@type")
                    if isinstance(data_types, str):
                        data_types = [data_types]
                    
                    if not isinstance(data_types, list):
                        continue

                    for dtype in data_types:
                        # Find the expected type this block satisfies, accounting for
                        # schema.org subtypes (e.g. ProductGroup satisfies Product).
                        matched_expected_type = None
                        for expected_type in expected_types:
                            accepted = SCHEMA_SUBTYPES.get(expected_type, {expected_type})
                            if dtype in accepted:
                                matched_expected_type = expected_type
                                break

                        if matched_expected_type is not None:
                            # Get the template entry to inherit requiredFields or other settings.
                            # Use the actual CSV type (dtype) as @type, not the template's base type,
                            # so the test validates against what's actually on the page.
                            config_entry = next((e for e in expected_value if e.get("@type") == matched_expected_type), {})

                            # Merge: keep config_entry settings, but fill in values from CSV
                            merged = config_entry.copy()
                            merged["@type"] = dtype  # preserve actual type (e.g. ProductGroup)
                            for k, v in block.items():
                                # Only import fields if the config doesn't already have a non-placeholder value
                                if k not in merged or merged[k] == "TODO":
                                    merged[k] = v

                            found_blocks.append(merged)
                            break  # Found a match for this block
            except (json.JSONDecodeError, TypeError) as e:
                # Provide a hint to the user if their CSV has invalid JSON-LD
                url = row[0] if row else "unknown"
                print(f"  ! Warning: Failed to parse JSON-LD in column '{header}' for {url}")
                print(f"    Error: {e}")
                continue

    # Return the full template configuration, but replace expected.value with found_blocks
    result = sd_cfg.copy()
    
    # Always ensure the expected block exists if it was enabled in the template
    if "expected" not in result:
        result["expected"] = {
            "enabled": expected_cfg.get("enabled", False),
            "severity": expected_cfg.get("severity", "warning"),
            "value": []
        }
    
    # If we found data in the CSV, use it. Otherwise, fallback to the template value
    if found_blocks:
        result["expected"] = {**expected_cfg, "value": found_blocks}
    else:
        # If nothing found, fallback to template's expected value (already in result)
        pass

    return result


def describe_path(path: str) -> str:
    """Generate a human-readable description from a URL path."""
    if path == "/":
        return "Home page"
    parts = [p for p in path.strip("/").split("/") if p]
    last = parts[-1] if parts else path
    # Convert slugs to title case words
    return " ".join(w.capitalize() for w in re.split(r"[-_]", last)) + " page"


def main():
    parser = argparse.ArgumentParser(
        description="Generate seo-checks.json from a CSV export (Screaming Frog or pages.template.csv)."
    )
    parser.add_argument("csv_file", nargs="?", help="Path to the Screaming Frog CSV export")
    parser.add_argument(
        "--config",
        default="generator-config.json",
        help="Path to generator-config.json (default: generator-config.json)",
    )
    parser.add_argument(
        "--out",
        default="seo-checks.json",
        help="Output file path (default: seo-checks.json)",
    )
    parser.add_argument(
        "--base-url",
        help="Override baseUrl from generator-config.json",
    )
    parser.add_argument(
        "--include-noindex",
        action="store_true",
        help="Include pages marked as Non-Indexable (skipped by default)",
    )
    parser.add_argument(
        "--include-non-200",
        action="store_true",
        help="Include pages with non-200 status codes (skipped by default)",
    )
    args = parser.parse_args()

    # ---- Check for CSV file and prompt if missing ----
    csv_file = args.csv_file
    if not csv_file:
        try:
            import questionary
            from questionary import Choice, Style
            custom_style = Style([
                ('qmark', 'fg:#5CC5A6 bold'),
                ('question', 'fg:#FFFFFF bold'),
                ('answer', 'fg:#5CC5A6'),
                ('pointer', 'fg:#5CC5A6 bold'),
                ('highlighted', 'fg:#5CC5A6 bold'),
                ('selected', 'fg:#5CC5A6'),
                ('separator', 'fg:#7C7C7C'),
                ('instruction', 'fg:#7C7C7C'),
            ])
            
            csv_candidates = [p.name for p in Path.cwd().glob("*.csv") if not p.name.startswith('.')]
            if csv_candidates:
                choices = [Choice(f"Use {c}", value=c) for c in csv_candidates]
                choices.append(Choice("Enter path manually", value="manual"))
                
                action = questionary.select(
                    "  No CSV file provided. Select a file to generate from:",
                    choices=choices,
                    style=custom_style
                ).ask()
                
                if action == "manual":
                    csv_file = questionary.text("  Path to CSV file:", style=custom_style).ask()
                else:
                    csv_file = action
            else:
                csv_file = questionary.text("  No CSV file provided. Path to CSV file:", style=custom_style).ask()
        except ImportError:
            print("ERROR: No CSV file provided. Pass it as an argument or install 'questionary' for interactive mode.", file=sys.stderr)
            sys.exit(1)

    if not csv_file:
        print("Aborted.")
        sys.exit(0)

    # ---- Load generator config ----
    config_path = Path(args.config)
    if not config_path.exists():
        print(f"ERROR: Config file not found: {config_path}", file=sys.stderr)
        print(
            "       Copy generator-config.example.json to generator-config.json and edit it.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        with open(config_path, encoding="utf-8") as f:
            gen_cfg = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to parse generator config at '{config_path}'", file=sys.stderr)
        print(f"       Check for syntax errors like missing commas or unmatched quotes.", file=sys.stderr)
        print(f"       Original error: {e}", file=sys.stderr)
        sys.exit(1)

    # Basic validation
    if not isinstance(gen_cfg, dict):
        print(f"ERROR: Invalid generator config format at '{config_path}'. Root must be a JSON object.", file=sys.stderr)
        sys.exit(1)
    
    if "templates" not in gen_cfg or not isinstance(gen_cfg["templates"], dict):
        print(f"ERROR: Missing or invalid 'templates' object in '{config_path}'.", file=sys.stderr)
        sys.exit(1)

    base_url = (args.base_url or gen_cfg.get("baseUrl", "")).rstrip("/")
    templates_cfg: dict = {
        k: v for k, v in gen_cfg.get("templates", {}).items() if not k.startswith("_")
    }

    # Template matching order: all non-catch-all templates first, "other" (or "default") last.
    # "other" is the preferred name; "default" is accepted for backward compatibility.
    catch_all = "other" if "other" in templates_cfg else "default"
    template_order = [k for k in templates_cfg if k != catch_all]
    if catch_all in templates_cfg:
        template_order.append(catch_all)

    # ---- Read CSV ----
    csv_path = Path(csv_file)
    if not csv_path.exists():
        print(f"ERROR: CSV file not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    pages = []
    seen_paths: set[str] = set()
    skipped_noindex = 0
    skipped_non200 = 0
    skipped_no_path = 0

    with open(csv_path, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        raw_headers = next(reader)
        col_map = build_column_map(raw_headers)

        if "address" not in col_map:
            print(
                "ERROR: Could not find an 'Address' (URL) column in the CSV.",
                file=sys.stderr,
            )
            print(
                f"       Found columns: {raw_headers}",
                file=sys.stderr,
            )
            sys.exit(1)

        # Warn if base_url domain doesn't match the first URL in the CSV
        if base_url:
            all_rows = list(reader)
            base_netloc = urlparse(base_url).netloc.lstrip("www.")
            for sample_row in all_rows:
                if not any(sample_row):
                    continue
                sample_url = get(sample_row, col_map, "address")
                if sample_url:
                    sample_netloc = urlparse(sample_url).netloc.lstrip("www.")
                    if sample_netloc and base_netloc and sample_netloc != base_netloc:
                        print(
                            f"\n  ! baseUrl domain ({urlparse(base_url).netloc}) doesn't match"
                            f" CSV URLs ({urlparse(sample_url).netloc})."
                        )
                        print("    Paths will still be extracted using the URL path directly.\n")
                    break
        else:
            all_rows = list(reader)

        for row in all_rows:
            if not any(row):
                continue

            url = get(row, col_map, "address")
            if not url:
                continue

            # Skip non-HTML rows that SF sometimes appends
            status_raw = get(row, col_map, "status_code")
            if status_raw and not args.include_non_200:
                try:
                    status = int(status_raw)
                    if status not in (200, 304):
                        skipped_non200 += 1
                        continue
                except ValueError:
                    pass

            indexability = get(row, col_map, "indexability").lower()
            if indexability and indexability != "indexable" and not args.include_noindex:
                skipped_noindex += 1
                continue

            # Derive relative path
            path = strip_base_url(url, base_url)
            if not path:
                if skipped_no_path < 5:  # Only show first 5 to avoid noise
                    print(f"  ! DEBUG: Could not resolve path for URL: '{url}' (base_url: '{base_url}')")
                skipped_no_path += 1
                continue

            # Remove query strings and fragments from path
            parsed = urlparse(path)
            path = parsed.path
            if not path:
                if skipped_no_path < 5:
                    print(f"  ! DEBUG: urlparse returned empty path for: '{path}' (original URL: '{url}')")
                skipped_no_path += 1
                continue

            if path in seen_paths:
                continue
            seen_paths.add(path)

            # Match template
            template_name = match_template(path, template_order, templates_cfg)
            template_checks = templates_cfg.get(template_name, {}).get("checks", {})

            # Extract from CSV
            title = get(row, col_map, "title")
            h1 = get(row, col_map, "h1")
            meta_desc = get(row, col_map, "meta_description")
            canonical_raw = get(row, col_map, "canonical")
            meta_robots = get(row, col_map, "meta_robots") or ""

            # Derive canonical: prefer relative path, strip base_url if absolute
            if canonical_raw:
                canonical = strip_base_url(canonical_raw, base_url)
                if canonical is None:
                    canonical = path  # fallback to self-referencing
            else:
                canonical = path  # default to self-referencing

            # Build seo object in Strict Object Schema
            title_val = title or f"TODO: add title for {path}"
            h1_val = h1 or ""
            meta_desc_val = meta_desc or ""
            meta_robots_val = meta_robots or ""

            # Get metadata config from template or use defaults
            meta_cfg = template_checks.get("metadata", {})
            def get_meta_info(field, default_sev="warning", default_enabled=False):
                f_cfg = meta_cfg.get(field, {})
                return f_cfg.get("enabled", default_enabled), f_cfg.get("severity", default_sev)

            t_enabled, t_sev = get_meta_info("title")
            h1_enabled, h1_sev = get_meta_info("h1")
            c_enabled, c_sev = get_meta_info("canonical")
            r_enabled, r_sev = get_meta_info("metaRobots")
            d_enabled, d_sev = get_meta_info("metaDescription", "warning")
            l_enabled, l_sev = get_meta_info("links", "warning")
            hr_enabled, hr_sev = get_meta_info("hreflang", "warning", default_enabled=False)

            seo: dict = {
                "metadata": {
                    "title": {"enabled": t_enabled, "severity": t_sev, "value": title_val},
                    "h1": {"enabled": h1_enabled, "severity": h1_sev, "value": h1_val},
                    "canonical": {"enabled": c_enabled, "severity": c_sev, "value": canonical},
                    "metaRobots": {"enabled": r_enabled, "severity": r_sev, "value": meta_robots_val},
                    "metaDescription": {"enabled": d_enabled, "severity": d_sev, "value": meta_desc_val},
                    "links": {"enabled": l_enabled, "severity": l_sev, "value": []},
                    "hreflang": {"enabled": hr_enabled, "severity": hr_sev, "value": None},
                }
            }

            # OG tags
            og_cfg = template_checks.get("ogTags", {})
            og_tags = build_og_tags(row, col_map, og_cfg)
            if og_tags:
                seo["ogTags"] = og_tags

            # Twitter cards
            tw_cfg = template_checks.get("twitterCards", {})
            twitter_cards = build_twitter_cards(row, col_map, tw_cfg)
            if twitter_cards:
                seo["twitterCards"] = twitter_cards

            # Structured Data (JSON-LD)
            sd_cfg = template_checks.get("structuredData", {})
            structured_data = build_structured_data(row, raw_headers, sd_cfg)
            if structured_data:
                seo["structuredData"] = structured_data

            page: dict = {
                "path": path,
                "template": template_name,
                "description": describe_path(path),
                "seo": seo,
            }

            pages.append(page)

    # ---- Report skipped rows early so user sees them before confirming ----
    if skipped_noindex:
        print(f"  Skipped {skipped_noindex} non-indexable pages (use --include-noindex to include).")
    if skipped_non200:
        print(f"  Skipped {skipped_non200} non-200/304 pages (use --include-non-200 to include).")
    if skipped_no_path:
        print(f"  Skipped {skipped_no_path} rows — URL could not be resolved to a path.")

    if not pages:
        print("\n  " + "!" * 60)
        print("  ERROR: No pages were extracted from the CSV.")
        print(f"  Total skipped: {skipped_noindex} non-indexable, {skipped_non200} non-200/304, {skipped_no_path} unresolvable URL.")
        print("  " + "!" * 60)
        print("\n  Possible reasons:")
        if skipped_no_path:
            print("  - The 'Address' column values are empty or malformed.")
            print("  - Your CSV might be using a different column separator (e.g. semicolon).")
        if skipped_noindex or skipped_non200:
            print("  - Most pages were filtered out. Use --include-noindex or --include-non-200.")
        print("\n  Try running with a simple 1-line CSV to test your format.")
        sys.exit(1)

    # ---- Match summary + interactive validation ----
    DIVIDER = "─" * 57

    while True:
        # Count pages and collect one sample URL per template
        counts: dict[str, int] = {}
        samples: dict[str, str] = {}
        for p in pages:
            t = p["template"]
            counts[t] = counts.get(t, 0) + 1
            if t not in samples:
                samples[t] = p["path"]

        print("\n  Template matching summary:")
        print("  " + DIVIDER)
        for tname in template_order:
            pattern = templates_cfg[tname].get("urlPattern", ".*")
            count = counts.get(tname, 0)
            sample = samples.get(tname, "(none)")
            count_label = f"{count} page{'s' if count != 1 else ''}"
            print(f"  {tname:<16} {pattern:<28} {count_label:<14} e.g. {sample}")

        catch_all_count = counts.get(catch_all, 0)
        if catch_all_count > 50:
            print(
                f"\n  ! \"{catch_all}\" matched {catch_all_count} pages"
                " — this may indicate a missing template pattern."
            )

        print()
        answer = input("  Does this look right? [Y/n] ").strip().lower()
        if answer in ("", "y", "yes"):
            break

        # Re-prompt urlPattern for adjustable templates (not home, not catch-all)
        print()
        adjustable = [t for t in template_order if t not in ("home", catch_all)]
        for tname in adjustable:
            old_pattern = templates_cfg[tname].get("urlPattern", f"^/{tname}/")
            new_raw = input(f"  URL pattern for '{tname}' [{old_pattern}]: ").strip()
            new_pattern = new_raw if new_raw else old_pattern
            templates_cfg[tname]["urlPattern"] = new_pattern

        # Re-classify all pages with updated patterns
        for page in pages:
            page["template"] = match_template(page["path"], template_order, templates_cfg)

        # Persist corrected patterns to generator-config.json
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(gen_cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print("  ✓  Updated patterns saved to generator-config.json\n")

    # ---- Build clean template output blocks (after patterns are confirmed) ----
    templates_out: dict = {}
    for tname, tcfg in templates_cfg.items():
        checks = tcfg.get("checks", {})
        wait = tcfg.get("waitForReady")
        pattern = tcfg.get("urlPattern")
        tentry: dict = {}
        # Carry urlPattern into the output so seo-checks.json supports E2E per-template sampling.
        # Skip ".*" (catch-all) — unmatched URLs go to the "(other)" group automatically.
        if pattern and pattern != ".*":
            tentry["urlPattern"] = pattern
        if wait:
            tentry["waitForReady"] = wait
        tentry["seo"] = build_checks_for_template(checks)
        templates_out[tname] = tentry

    # ---- Assemble output ----
    output: dict = {}

    if base_url:
        output["baseUrl"] = base_url

    if gen_cfg.get("sampleConfig"):
        output["sampleConfig"] = gen_cfg["sampleConfig"]

    if gen_cfg.get("crawlConfig"):
        output["crawlConfig"] = gen_cfg["crawlConfig"]

    if templates_out:
        output["templates"] = templates_out

    output["pages"] = pages

    # ---- Write output ----
    out_path = Path(args.out)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n  ✓  Generated {out_path} with {len(pages)} pages.")

    print()
    print("  Next steps:")
    print("  1. Review the generated file and fix any pages with 'TODO: add title'")
    print("  2. Add structured data expectations manually (structuredData.expected)")
    print("  3. Validate: npx playwright test tests/unit/")


if __name__ == "__main__":
    main()
