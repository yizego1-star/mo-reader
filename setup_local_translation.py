#!/usr/bin/env python3
"""Download the English-to-Chinese Argos model into the Mo Reader folder."""

import os
from pathlib import Path

import argostranslate.package as package


APP_ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("ARGOS_PACKAGES_DIR", APP_ROOT / ".paper-reader-data" / "translation-models"))


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if any(MODEL_DIR.glob("translate-en_zh-*")):
        print("本地英译中模型已存在。")
        return
    print("正在下载本地英译中模型（约 70 MB）……")
    package.update_package_index()
    available = [item for item in package.get_available_packages() if item.from_code == "en" and item.to_code == "zh"]
    if not available:
        raise RuntimeError("没有找到英译中模型")
    package.install_from_path(available[0].download())
    print("本地英译中模型已准备完成。")


if __name__ == "__main__":
    main()
