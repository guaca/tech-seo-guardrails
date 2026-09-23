"""
Shared path constant for the CSV-generator scripts (generate-from-sf.py,
init-generator-config.py). All wizard-generated/consumed files live under one
folder in the consumer's project root — mirrors the .github/workflows/
convention (a dot-folder, fully visible to git; the leading dot only affects
default `ls` listing).
"""

from pathlib import Path

GUARDRAILS_DIR_NAME = ".tech-seo-guardrails"


def guardrails_dir(base: Path | None = None) -> Path:
    return (base or Path.cwd()) / GUARDRAILS_DIR_NAME
