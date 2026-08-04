#!/usr/bin/env python3
"""Translate one selected passage with the local Argos English-Chinese model."""

import json
import sys

import argostranslate.translate as translate


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else ""
    if not text.strip():
        raise ValueError("text is required")
    result = translate.translate(text, "en", "zh")
    print(json.dumps({"translation": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
