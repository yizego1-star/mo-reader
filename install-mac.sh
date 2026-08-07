#!/bin/zsh
# 墨读 macOS 一键安装器。运行：curl -fsSL <GitHub raw URL> | zsh
set -euo pipefail

REPOSITORY="https://github.com/yizego1-star/mo-reader"
REF="${MO_READER_REF:-agent/local-sentence-translation}"
INSTALL_DIR="${MO_READER_INSTALL_DIR:-$HOME/Applications/墨读}"
ARCHIVE_URL="${REPOSITORY}/archive/refs/heads/${REF}.tar.gz"
CHINA_MODE="${MO_READER_CN:-0}"

say() { print -P "\n%F{green}墨读%f  $1"; }
fail() { print -P "%F{red}安装失败：%f$1" >&2; exit 1; }

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then return; fi
  say "正在安装 Homebrew（用于准备 Node.js 与 Python）…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"
  else fail "Homebrew 安装后仍不可用。"
  fi
}

ensure_runtime() {
  if ! command -v node >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    ensure_brew
    command -v node >/dev/null 2>&1 || brew install node
    command -v python3 >/dev/null 2>&1 || brew install python
  fi
}

[[ "$(uname)" == "Darwin" ]] || fail "此安装器目前只支持 macOS。"
[[ ! -e "$INSTALL_DIR" ]] || fail "安装目录已存在：$INSTALL_DIR\n如需重新安装，请先移走该文件夹，或设置 MO_READER_INSTALL_DIR。"
command -v curl >/dev/null 2>&1 || fail "系统没有 curl。"
command -v tar >/dev/null 2>&1 || fail "系统没有 tar。"

if [[ "$CHINA_MODE" == "1" ]]; then
  # 安装脚本本身仍由 GitHub 原站下载；仅把较大的依赖与资源切换到镜像。
  ARCHIVE_URL="${MO_READER_ARCHIVE_URL:-https://ghfast.top/${REPOSITORY}/archive/refs/heads/${REF}.tar.gz}"
  export npm_config_registry="https://registry.npmmirror.com"
  export PIP_INDEX_URL="https://mirrors.aliyun.com/pypi/simple"
  export PAPER_READER_DICTIONARY_URL="https://ghfast.top/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
  say "已启用中国大陆加速镜像。"
fi

ensure_runtime

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mo-reader.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT
say "正在下载墨读…"
curl -fL --retry 3 "$ARCHIVE_URL" -o "$TEMP_DIR/mo-reader.tar.gz"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TEMP_DIR/mo-reader.tar.gz" --strip-components=1 -C "$INSTALL_DIR"

say "正在安装阅读器依赖…"
cd "$INSTALL_DIR"
if ! npm install --omit=dev; then
  if [[ "$CHINA_MODE" == "1" ]]; then
    say "npm 镜像暂时不可用，正在回退官方源…"
    npm_config_registry="https://registry.npmjs.org" npm install --omit=dev
  else
    fail "npm 依赖安装失败。"
  fi
fi
python3 -m venv .venv
if ! "$INSTALL_DIR/.venv/bin/python" -m pip install --upgrade pip; then
  if [[ "$CHINA_MODE" == "1" ]]; then
    say "Python 镜像暂时不可用，正在回退官方源…"
    PIP_INDEX_URL="" "$INSTALL_DIR/.venv/bin/python" -m pip install --upgrade pip
  else
    fail "pip 升级失败。"
  fi
fi
if ! "$INSTALL_DIR/.venv/bin/python" -m pip install -r requirements.txt; then
  if [[ "$CHINA_MODE" == "1" ]]; then
    say "Python 镜像暂时不可用，正在回退官方源…"
    PIP_INDEX_URL="" "$INSTALL_DIR/.venv/bin/python" -m pip install -r requirements.txt
  else
    fail "Python 依赖安装失败。"
  fi
fi

say "正在准备离线词典与句子翻译模型（首次约需下载 130MB）…"
"$INSTALL_DIR/.venv/bin/python" setup_local_dictionary.py
ARGOS_PACKAGES_DIR="$INSTALL_DIR/.paper-reader-data/translation-models" "$INSTALL_DIR/.venv/bin/python" setup_local_translation.py

say "正在创建可双击启动的墨读.app…"
mkdir -p "$INSTALL_DIR/墨读.app/Contents/MacOS" "$INSTALL_DIR/墨读.app/Contents/Resources/MoReader.iconset"
cat > "$INSTALL_DIR/启动墨读.command" <<'LAUNCHER'
#!/bin/zsh
set -u
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PAPER_READER_PORT:-4317}"
NODE_BIN="$(command -v node 2>/dev/null || true)"
PYTHON_BIN="$APP_DIR/.venv/bin/python"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { osascript -e 'display alert "墨读启动失败" message "没有找到 Node.js。"'; exit 1; }
export PAPER_READER_PYTHON="$PYTHON_BIN"
export PAPER_READER_ARGOS_PACKAGES_DIR="$APP_DIR/.paper-reader-data/translation-models"
if ! curl -fsS "http://127.0.0.1:${PORT}/api/papers" >/dev/null 2>&1; then
  nohup "$NODE_BIN" "$APP_DIR/server.mjs" >"$APP_DIR/.paper-reader-data/server.log" 2>&1 < /dev/null &
  for _ in {1..24}; do curl -fsS "http://127.0.0.1:${PORT}/api/papers" >/dev/null 2>&1 && break; sleep 0.25; done
fi
if curl -fsS "http://127.0.0.1:${PORT}/api/papers" >/dev/null 2>&1; then open "http://127.0.0.1:${PORT}"; else osascript -e 'display alert "墨读启动失败" message "本地服务没有成功启动。"'; exit 1; fi
LAUNCHER
cat > "$INSTALL_DIR/墨读.app/Contents/MacOS/墨读" <<'APP'
#!/bin/zsh
APP_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
/usr/bin/open "$APP_DIR/启动墨读.command"
APP
cat > "$INSTALL_DIR/墨读.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>墨读</string>
<key>CFBundleName</key><string>墨读</string>
<key>CFBundleIdentifier</key><string>local.modu.reader</string>
<key>CFBundleVersion</key><string>1.0.0</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>MoReader.icns</string>
<key>CFBundleExecutable</key><string>墨读</string>
</dict></plist>
PLIST
chmod +x "$INSTALL_DIR/启动墨读.command" "$INSTALL_DIR/墨读.app/Contents/MacOS/墨读"
for item in '16 icon_16x16.png' '32 icon_16x16@2x.png' '32 icon_32x32.png' '64 icon_32x32@2x.png' '128 icon_128x128.png' '256 icon_128x128@2x.png' '256 icon_256x256.png' '512 icon_256x256@2x.png' '512 icon_512x512.png' '1024 icon_512x512@2x.png'; do
  set -- $item
  sips -s format png -z "$1" "$1" "$INSTALL_DIR/mo-reader-logo.svg" --out "$INSTALL_DIR/墨读.app/Contents/Resources/MoReader.iconset/$2" >/dev/null
done
iconutil -c icns "$INSTALL_DIR/墨读.app/Contents/Resources/MoReader.iconset" -o "$INSTALL_DIR/墨读.app/Contents/Resources/MoReader.icns"

say "安装完成，正在打开墨读。"
open "$INSTALL_DIR/墨读.app"
print "安装位置：$INSTALL_DIR"
