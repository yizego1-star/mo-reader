#!/usr/bin/env python3
"""Download and prepare the local English-Chinese dictionary for Mo Reader."""

import csv
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
DATA_ROOT = APP_ROOT / ".paper-reader-data" / "dictionary"
OFFICIAL_SOURCE_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
SOURCE_URL = os.environ.get("PAPER_READER_DICTIONARY_URL", OFFICIAL_SOURCE_URL)
RAW_FILE = DATA_ROOT / "ecdict.csv"
POS_LABELS = {
    "n": "名词",
    "v": "动词",
    "a": "形容词",
    "s": "形容词",
    "ad": "副词",
    "adv": "副词",
    "prep": "介词",
    "pron": "代词",
    "conj": "连词",
    "aux": "助动词",
    "int": "感叹词",
    "art": "冠词",
    "article": "冠词",
}


def clean(value):
    return re.sub(r"\s+", " ", (value or "").replace("\\n", "；")).strip()


def clean_translation(value):
    return re.sub(r"^(?:n|v|a|s|ad|adv|prep|pron|conj|aux|int)\.\s*", "", clean(value), flags=re.I)


def pos_label(value):
    values = []
    for raw in re.split(r"[\s/]+", value or ""):
        key = raw.rstrip(".").lower()
        if key and key not in values:
            values.append(key)
    labels = [POS_LABELS.get(value, value) for value in values]
    return " / ".join(dict.fromkeys(labels)) or "语境词性"


def main():
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    if not RAW_FILE.exists():
        print("正在下载 ECDICT 本地英汉词典（约 63 MB）……")
        try:
            urllib.request.urlretrieve(SOURCE_URL, RAW_FILE)
        except Exception:
            if SOURCE_URL == OFFICIAL_SOURCE_URL:
                raise
            print("镜像下载失败，正在回退官方词典源…")
            urllib.request.urlretrieve(OFFICIAL_SOURCE_URL, RAW_FILE)

    buckets = {chr(code): {} for code in range(ord("a"), ord("z") + 1)}
    with RAW_FILE.open("r", encoding="utf-8", newline="") as stream:
        for row in csv.DictReader(stream):
            word = clean(row.get("word")).lower()
            if not re.fullmatch(r"[a-z]+", word):
                continue
            raw_translation = clean(row.get("translation"))
            translation = clean_translation(raw_translation)
            definition = clean(row.get("definition"))
            if not translation and not definition:
                continue
            detected_pos = pos_label(row.get("pos"))
            if detected_pos == "语境词性":
                match = re.match(r"^(n|v|a|s|ad|adv|prep|pron|conj|aux|int|art|article)\.\s*", raw_translation, flags=re.I)
                if match:
                    detected_pos = POS_LABELS.get(match.group(1).lower(), "语境词性")
            buckets[word[0]][word] = {
                "translation": translation,
                "definition": definition,
                "posLabel": detected_pos,
                "phonetic": clean(row.get("phonetic")),
            }

    for letter, entries in buckets.items():
        output = DATA_ROOT / f"{letter}.json"
        output.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    RAW_FILE.unlink(missing_ok=True)
    count = sum(len(entries) for entries in buckets.values())
    print(f"本地词典已准备完成：{count:,} 个词条")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        raise SystemExit(130)
