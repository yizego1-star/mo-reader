# 墨读 · 论文精读

一个运行在本机的 PDF 英文论文精读工具：原文保持不变，选中单词或句子后临时显示中文解释；单词会自动发音，也可以加入生词本。阅读页顶部固定搜索栏和模式切换，搜索栏可以查词并定位到论文中的出现位置。

## 快速开始

需要 Node.js 18+、Python 3.10+。

### macOS 一键安装

将下面这一条命令粘贴到 macOS「终端」运行，即可下载、配置离线词典与翻译模型，并生成可双击打开的 `墨读.app`。首次安装会下载约 130MB 的离线资源；若电脑没有 Node.js 或 Python，安装器会通过 Homebrew 自动准备它们。

```bash
curl -fsSL https://raw.githubusercontent.com/yizego1-star/mo-reader/agent/local-sentence-translation/install-mac.sh | zsh
```

安装后应用位于 `~/Applications/墨读/墨读.app`。此安装器目前只支持 macOS。

### Windows 一键安装

在 Windows 10/11 中以普通方式打开 PowerShell，粘贴下面这一条命令。它会下载、配置离线资源，并在桌面创建“墨读”快捷方式；若缺少 Node.js 或 Python，会通过 `winget` 自动安装。

```powershell
irm https://raw.githubusercontent.com/yizego1-star/mo-reader/agent/local-sentence-translation/install-windows.ps1 | iex
```

安装后文件位于 `%LOCALAPPDATA%\墨读`，以后双击桌面“墨读”即可启动。

```bash
npm install
python3 -m pip install -r requirements.txt
python3 setup_local_dictionary.py
python3 setup_local_translation.py
npm start
```

然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。停止服务时在终端按 `Ctrl + C`。

## 放入论文

默认把 PDF 放在应用目录的上一级 `论文库` 文件夹中：

```text
项目目录/
├── 墨读应用/
└── 论文库/
```

也可以通过环境变量指定任意论文目录：

```bash
PAPER_READER_PAPERS_DIR="/path/to/your/papers" npm start
```

在论文库点击“添加论文或阅读资料”，可以选择多个本地 PDF、选择文件夹，或直接把 PDF 拖入导入区。导入后会自动刷新论文列表，并为论文卡片生成一句简短中文概括；也仍然可以直接把新的 `.pdf` 文件放入论文目录后点击“刷新论文库”。

## 阅读模式与翻译

打开应用后默认进入在线模式，也可以在主界面或阅读界面随时切换。在线模式优先调用已配置的 AI 接口、Google 翻译和 Lingva，失败后回退到本地能力；离线模式只使用本地 ECDICT 英汉词典、本地 Argos Translate 英译中模型和系统语音，不访问网络。离线选中单句、多句或多段英文时，会自动按句子和长度分块翻译，再合并为完整中文。首次使用前运行一次 `python3 setup_local_dictionary.py` 和 `python3 setup_local_translation.py`，即可离线查询词性、中文释义、音标并翻译句子。

如果希望完全离线运行，可这样启动：

```bash
PAPER_READER_OFFLINE=1 npm start
```

若要接入 OpenAI-compatible 服务，可在启动前设置：

```bash
PAPER_READER_AI_URL="你的接口地址" \
PAPER_READER_AI_KEY="你的密钥" \
PAPER_READER_AI_MODEL="你的模型名" \
npm start
```

密钥只通过环境变量提供，不要写入代码或提交到 Git。

## 批注

阅读页左侧提供红、蓝、绿三色批注笔，每种都可切换透明马克笔或实线笔。选中批注笔后再划选文字只会添加批注，不会触发翻译；选中擦除工具后划选已批注内容会删除对应批注。批注独立保存在本地数据文件中，不会改写原 PDF。

## 阅读与论文库界面

阅读时顶部栏和左侧工具栏会固定显示。左侧的 `＋ / 100 / －` 可只放大或缩小 PDF 正文，工具与搜索栏不会随正文消失；点击 `100` 可恢复默认大小。论文库“全部论文”右侧的两个按钮可切换网格或列表陈列，选择会自动记住。

## 数据与隐私

生词本、翻译缓存、概括缓存和批注保存在本地 `.paper-reader-data`，论文目录和 PDF 默认不会提交到 Git。启动端口可通过 `PAPER_READER_PORT` 修改。
