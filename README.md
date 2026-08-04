# 墨读 · 论文精读

一个运行在本机的 PDF 英文论文精读工具：原文保持不变，选中单词或句子后临时显示中文解释；单词会自动发音，也可以加入生词本。阅读页右上角的搜索栏可以查词并定位到论文中的出现位置。

## 快速开始

需要 Node.js 18+、Python 3.10+。

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

把新的 `.pdf` 文件放入论文目录后，在论文库点击“刷新论文库”即可。

## AI 翻译

句子翻译优先使用本地 Argos Translate 英译中模型，不受在线额度限制；单词使用本地 ECDICT 英汉词典。首次使用前运行一次 `python3 setup_local_dictionary.py` 和 `python3 setup_local_translation.py`，即可离线查询词性、中文释义、音标并翻译句子。

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

## 数据与隐私

生词本、翻译缓存和概括缓存保存在本地 `.paper-reader-data`，论文目录和 PDF 默认不会提交到 Git。启动端口可通过 `PAPER_READER_PORT` 修改。
