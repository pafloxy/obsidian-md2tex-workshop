"""Minimal external-adapter fixture, not a Markdown converter.

Usage: python3 external-converter.py INPUT --stdout --body-only
Accept only the one synthetic sentence used by the adapter integration test.
"""
import argparse
from pathlib import Path


def main() -> None:
    """Verify the adapter invocation and emit a fixed, harmless TeX body."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--stdout", action="store_true", required=True)
    parser.add_argument("--body-only", action="store_true", required=True)
    args = parser.parse_args()
    if args.input.read_text(encoding="utf-8").strip() != "# Draft\n\nA complete sentence.":
        parser.error("Unexpected fixture input; this is only an adapter test double")
    print(r"\section{Draft}" + "\n\nA complete sentence.")


if __name__ == "__main__":
    main()
