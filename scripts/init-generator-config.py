#!/usr/bin/env python3
"""
init-generator-config.py — Interactive wizard to create generator-config.json.

Walks you through defining your site's page templates (URL patterns)
so that generate-from-sf.py can turn a CSV export into a ready-to-use seo-checks.json.

After defining templates, this script hands off to the Node.js configuration
utility for granular SEO check selection and severity tuning.
"""

import argparse
import csv
import json
import re
import sys
import subprocess
from pathlib import Path
from collections import defaultdict
from urllib.parse import urlparse


def read_env_value(key: str) -> str:
    """Read a single value from .env in the current working directory."""
    env_path = Path.cwd() / ".env"
    if not env_path.exists():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip()
    return ""


try:
    import questionary
    from questionary import Choice, Style
except ImportError:
    print(
        "\nERROR: questionary is required for this wizard.\n"
        "Install it with:\n\n"
        "  pip install questionary\n",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Custom styling to match the Node.js setup scripts
# ---------------------------------------------------------------------------
custom_style = Style([
    ('qmark', 'fg:#5CC5A6 bold'),       # token in front of the question
    ('question', 'fg:#FFFFFF bold'),    # question text
    ('answer', 'fg:#5CC5A6'),           # submitted answer text behind the question
    ('pointer', 'fg:#5CC5A6 bold'),     # pointer used in select and checkbox prompts
    ('highlighted', 'fg:#5CC5A6 bold'), # pointed-at choice in select and checkbox prompts
    ('selected', 'fg:#5CC5A6'),         # style for a selected item of a checkbox
    ('separator', 'fg:#7C7C7C'),        # separator in lists
    ('instruction', 'fg:#7C7C7C'),      # user instructions for select, confirm, etc.
    ('text', ''),                       # plain text
    ('disabled', 'fg:#858585 italic')   # disabled choices
])


# ---------------------------------------------------------------------------
# CSV Parsing & Template Discovery
# ---------------------------------------------------------------------------
COLUMN_ALIASES = {
    "address": "address",
    "url": "address",
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

def get_col(row: list[str], col_map: dict[str, int], field: str) -> str:
    idx = col_map.get(field)
    return row[idx].strip() if idx is not None and idx < len(row) else ""

def discover_templates(csv_path: str, base_url: str) -> tuple[list[dict], list[str]]:
    """Analyze CSV to find common URL patterns and suggest templates."""
    paths = []
    try:
        with open(csv_path, encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            try:
                raw_headers = next(reader)
            except StopIteration:
                return [], []
            
            col_map = build_column_map(raw_headers)
            if "address" not in col_map:
                return [], []

            for row in reader:
                url = get_col(row, col_map, "address")
                if not url: continue
                parsed = urlparse(url)
                path = parsed.path or "/"
                if not path.startswith("/"): path = "/" + path
                paths.append(path)
    except Exception:
        return [], []

    if not paths:
        return [], []

    patterns = defaultdict(int)
    for p in paths:
        if p == "/": continue
        
        segments = p.strip("/").split("/")
        if not segments: continue
        
        # Level 1: /about/team -> about
        patterns[segments[0]] += 1
        
        # Level 2: /about/team/members -> about/team
        if len(segments) > 1:
            patterns[segments[0] + "/" + segments[1]] += 1

    # Filter patterns that have at least 2 URLs
    # Sort by depth so more specific patterns (Level 2) are matched before Level 1
    candidates = sorted(
        [(p, count) for p, count in patterns.items() if count >= 2],
        key=lambda x: (len(x[0].split("/")), x[1]),
        reverse=True
    )
    
    suggested = [{"name": "home", "pattern": "^/$"}]
    seen_patterns = set()
    
    for pat, count in candidates:
        name = pat.split("/")[-1]
        if name in seen_patterns:
            name = pat.replace("/", "_")
        
        # Improved regex to handle missing trailing slashes reliably
        regex = f"^/{pat}(/|$)"
        suggested.append({"name": name, "pattern": regex})
        seen_patterns.add(name)
            
    return suggested, paths

def count_template_matches(templates: list[dict], paths: list[str]) -> dict[str, int]:
    """Count how many paths in the list match each template."""
    counts = {t["name"]: 0 for t in templates}
    counts["other"] = 0
    if not paths:
        return counts

    compiled = []
    for t in templates:
        try:
            compiled.append((t["name"], re.compile(t["pattern"])))
        except re.error:
            continue

    for p in paths:
        matched = False
        for name, regex in compiled:
            if regex.search(p):
                counts[name] += 1
                matched = True
                break
        if not matched:
            counts["other"] += 1
            
    return counts


# ---------------------------------------------------------------------------
# Template wizard
# ---------------------------------------------------------------------------

def wait_for_user(message: str = "Press Enter to continue..."):
    print(f"\n  {message}")
    input("  ")


def configure_template(name: str, url_pattern: str, is_default: bool = False, is_home: bool = False, global_wait_strategy: str | None = None) -> dict:
    """Ask for wait strategy for a specific template."""

    # Simple terminal coloring
    CYAN = "\033[36m"
    RESET = "\033[0m"

    if is_home or is_default:
        wait_strategy = global_wait_strategy or "networkidle"
        print(f"  Wait strategy for [{CYAN}{name}{RESET}]: {wait_strategy} (default)")
    else:
        if global_wait_strategy:
            wait_strategy = global_wait_strategy
            print(f"  Wait strategy for [{CYAN}{name}{RESET}]: {wait_strategy} (global setting)")
        else:
            wait_strategy = questionary.select(
                f"  Wait strategy for [{CYAN}{name}{RESET}]:",
                choices=[
                    Choice("networkidle — JS renders or modifies any content after load (default, always safe)", value="networkidle"),
                    Choice("load       — all content is in the server HTML, JS never modifies it", value="load"),
                ],
                default="networkidle",
                style=custom_style,
            ).ask()

    return {
        "urlPattern": url_pattern,
        "waitForReady": wait_strategy,
        "checks": {}, # Initialized empty; user will tune via Node CLI
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interactive wizard to create generator-config.json for the CSV-based seo-checks.json generator."
    )
    parser.add_argument(
        "csv_file",
        nargs="?",
        default=None,
        help="Optional: Path to the Screaming Frog CSV export to auto-discover templates",
    )
    parser.add_argument(
        "--out",
        default="generator-config.json",
        help="Output path (default: generator-config.json)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing file without prompting",
    )
    parser.add_argument(
        "--wait-strategy",
        choices=["networkidle", "load"],
        help="Optional: Global wait strategy to skip individual template prompts",
    )
    parser.add_argument(
        "--base-url",
        help="Optional: Production base URL to skip the prompt",
    )
    parser.add_argument(
        "--sample-limit",
        type=int,
        help="Optional: Max pages per template to skip the prompt",
    )
    args = parser.parse_args()
    out_path = Path(args.out)

    if out_path.exists() and not args.force:
        overwrite = questionary.confirm(
            f"\n  {out_path} already exists. Overwrite?", default=False, style=custom_style
        ).ask()
        if not overwrite:
            print("  Aborted.")
            sys.exit(0)

    print()
    print("  Tech SEO Guardrails — Generator Config Setup")
    print("  " + "─" * 52)
    print("  This wizard creates generator-config.json, which tells")
    print("  generate-from-sf.py how to classify your CSV page data")
    print("  into templates and produce a valid seo-checks.json contract.")
    
    if not args.base_url:
        wait_for_user("First, we will set up your site basics. (Enter to continue)")

    # ── Step 1: Site basics ──────────────────────────────────────────────────
    print("\n  Step 1: Site basics\n")

    if args.base_url:
        base_url = args.base_url.strip().rstrip("/")
        print(f"  Production base URL: {base_url}")
    else:
        env_base_url = read_env_value("PROD_BASE_URL")
        base_url = (
            questionary.text(
                "  Production base URL (e.g. https://your-site.com):",
                default=env_base_url,
                validate=lambda v: bool(v.strip()) or "Base URL is required",
                style=custom_style,
            ).ask() or ""
        ).strip().rstrip("/")

    sitemap_url = (
        questionary.text("  Sitemap path:", default="/sitemap.xml", style=custom_style).ask() or "/sitemap.xml"
    ).strip()

    env_max_urls = read_env_value("SEO_SAMPLE_LIMIT")
    default_max_urls = int(env_max_urls) if env_max_urls.isdigit() else 500
    max_urls = int(questionary.text("  Max URLs to crawl in E2E tests:", default=str(default_max_urls), style=custom_style).ask() or default_max_urls)

    # ── Step 2: Sampling ─────────────────────────────────────────────────────
    print("\n  Step 2: Sampling\n")

    if args.sample_limit is not None:
        max_pages = args.sample_limit
        print(f"  Max pages per template: {max_pages} (from setup wizard)")
    else:
        print("  To keep tests fast, we sample a subset of pages for each template.")
        env_sample_limit = read_env_value("SEO_SAMPLE_LIMIT")
        default_max_pages = int(env_sample_limit) if env_sample_limit.isdigit() else 50
        max_pages = int(questionary.text(
            "  Max pages per template to run integration tests on (random sampling):", default=str(default_max_pages), style=custom_style
        ).ask() or default_max_pages)

    # ── Step 3: Template Discovery and Management ────────────────────────────
    print("\n  Step 3: Page templates\n")
    
    csv_path = args.csv_file
    templates_list = []
    csv_paths = []

    if not csv_path:
        csv_candidates = [p.name for p in Path.cwd().glob("*.csv")]
        if csv_candidates:
            choices = [Choice(f"Use {c}", value=c) for c in csv_candidates]
            choices.append(Choice("Enter path manually", value="manual"))
            choices.append(Choice("Skip auto-discovery", value="skip"))
            
            action = questionary.select(
                "  Do you want to auto-discover templates from a CSV file?",
                choices=choices,
                style=custom_style
            ).ask()
            
            if action not in ("skip", "manual", None):
                csv_path = action
            elif action == "manual":
                csv_path = questionary.text(
                    "  Path to CSV file:",
                    style=custom_style
                ).ask()
        else:
            use_csv = questionary.confirm(
                "  Do you want to auto-discover templates from a CSV file? (Optional)",
                default=False,
                style=custom_style
            ).ask()
            if use_csv:
                csv_path = questionary.text(
                    "  Path to CSV file:",
                    style=custom_style
                ).ask()

    if csv_path and Path(csv_path).exists():
        print(f"  Analyzing CSV: {csv_path} ...")
        templates_list, csv_paths = discover_templates(csv_path, base_url)
        if templates_list:
            print(f"  Discovered {len(templates_list)} potential templates.")
        else:
            print("  Could not discover any patterns from the CSV. Proceeding with manual setup.")
            templates_list = [{"name": "home", "pattern": "^/$"}]
    else:
        if csv_path:
             print(f"  File not found: {csv_path}. Proceeding with manual setup.")
        templates_list = [{"name": "home", "pattern": "^/$"}]

    while True:
        counts = count_template_matches(templates_list, csv_paths)
        print("\n  Current templates:")
        print("  " + "─" * 70)
        for i, t in enumerate(templates_list):
            count_label = f"({counts[t['name']]} URLs)" if csv_paths else ""
            print(f"  {i+1}. {t['name']:<20} {t['pattern']:<30} {count_label}")
        
        other_label = f"({counts['other']} URLs)" if csv_paths else ""
        print(f"  -. {'other':<20} {'(catch-all for remaining)':<30} {other_label}")
        print("  " + "─" * 70)
        
        choices = [
            Choice("Continue to finalize setup", value="continue"),
            Choice("Add a template", value="add"),
        ]
        if templates_list:
            choices.extend([
                Choice("Rename a template", value="rename"),
                Choice("Edit a template pattern", value="edit"),
                Choice("Remove a template", value="remove"),
            ])
            
        action = questionary.select(
            "  What would you like to do?",
            choices=choices,
            style=custom_style
        ).ask()
        
        if action == "continue":
            break
        elif action == "add":
            name = questionary.text("  Template name:", style=custom_style).ask().strip()
            if name:
                pattern = questionary.text("  URL pattern (regex):", default=f"^/{name}/", style=custom_style).ask().strip()
                if pattern and csv_paths:
                    try:
                        regex = re.compile(pattern)
                        matches = sum(1 for p in csv_paths if regex.search(p))
                        print(f"  > Matched {matches} URLs (raw pattern match)")
                    except re.error:
                        print("  > Matched 0 URLs (invalid regex)")
                if pattern:
                    templates_list.append({"name": name, "pattern": pattern})
        elif action == "rename":
            t_name = questionary.select(
                "  Which template to rename?",
                choices=[t["name"] for t in templates_list],
                style=custom_style
            ).ask()
            new_name = questionary.text("  New name:", default=t_name, style=custom_style).ask().strip()
            if new_name:
                for t in templates_list:
                    if t["name"] == t_name:
                        t["name"] = new_name
                        break
        elif action == "edit":
            t_name = questionary.select(
                "  Which template to edit?",
                choices=[t["name"] for t in templates_list],
                style=custom_style
            ).ask()
            for t in templates_list:
                if t["name"] == t_name:
                    new_pattern = questionary.text("  New URL pattern:", default=t["pattern"], style=custom_style).ask().strip()
                    if new_pattern and csv_paths:
                        try:
                            regex = re.compile(new_pattern)
                            matches = sum(1 for p in csv_paths if regex.search(p))
                            print(f"  > Matched {matches} URLs (raw pattern match)")
                        except re.error:
                            print("  > Matched 0 URLs (invalid regex)")
                    if new_pattern:
                        t["pattern"] = new_pattern
                    break
        elif action == "remove":
            t_name = questionary.select(
                "  Which template to remove?",
                choices=[t["name"] for t in templates_list],
                style=custom_style
            ).ask()
            templates_list = [t for t in templates_list if t["name"] != t_name]


    # ── Step 4: Finalizing ───────────────────────────────────────────────────
    print("\n  Step 4: Finalizing baseline configuration")

    templates_cfg: dict = {}
    for t in templates_list:
        templates_cfg[t["name"]] = configure_template(
            t["name"], 
            url_pattern=t["pattern"], 
            is_home=(t["name"] == "home"),
            global_wait_strategy=args.wait_strategy
        )

    # ── Other catch-all ──────────────────────────────────────────────────────
    counts = count_template_matches(templates_list, csv_paths) if csv_paths else {"other": 1}

    if csv_paths and counts.get("other", 0) == 0:
        templates_cfg["other"] = {
            "urlPattern": ".*",
            "waitForReady": args.wait_strategy or "networkidle",
            "checks": {},
        }
    else:
        templates_cfg["other"] = configure_template(
            "other", 
            url_pattern=".*", 
            is_default=True, 
            global_wait_strategy=args.wait_strategy
        )

    # ── Assemble and write ────────────────────────────────────────────────────
    output = {
        "baseUrl": base_url,
        "sampleConfig": {"maxPagesPerTemplate": max_pages},
        "crawlConfig": {
            "sitemapUrl": sitemap_url,
            "maxUrls": max_urls,
            "concurrency": 10,
            "timeoutMs": 10000,
            "linkSampleSize": 5,
            "sitemapUrlsShouldNotRedirect": True,
        },
        "templates": templates_cfg,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"\n  ✓  Baseline configuration saved to {out_path}")
    print(f"\n  Launching the interactive check manager...")
    print(f"  Use this to turn specific SEO tests on/off and set their severities.")

    # ── HANDOFF TO NODE UI ────────────────────────────────────────────────────
    try:
        # If installed as a dependency, use npx to find the binary
        if "node_modules" in str(Path(__file__).resolve()):
            subprocess.run(["npx", "seo-configure"], check=True)
        else:
            # Local development
            subprocess.run(["npm", "run", "configure"], check=True)
    except Exception:
        print(f"\n  Notice: Could not launch the configuration UI automatically.")
        print(f"  Please run 'npx seo-configure' (or 'npm run configure') manually to finish your setup.")

    print()
    print("  Configuration complete!")

    # Check if we are running as a dependency
    import os
    is_dep = "node_modules" in os.path.abspath(__file__)
    gen_cmd = "npm run seo:generate" if is_dep else "npm run generate"
    test_cmd = "npm run seo:test" if is_dep else "npm test"

    print("  Next steps:")
    print("  1. Prepare your CSV (Screaming Frog All Tabs or pages.template.csv)")
    print(f"  2. Generate your contract: {gen_cmd} -- your-crawl.csv")
    print(f"  3. Run tests: {test_cmd}")
    print()


if __name__ == "__main__":
    main()
