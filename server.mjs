import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAPERS_DIR = path.resolve(APP_ROOT, process.env.PAPER_READER_PAPERS_DIR || path.join("..", "论文库"));
const DATA_DIR = path.join(APP_ROOT, ".paper-reader-data");
const VOCAB_FILE = path.join(DATA_DIR, "vocabulary.json");
const TRANSLATION_CACHE_FILE = path.join(DATA_DIR, "translation-cache.json");
const SUMMARY_CACHE_FILE = path.join(DATA_DIR, "summary-cache.json");
const LOCAL_DICTIONARY_DIR = path.join(DATA_DIR, "dictionary");
const LOCAL_TRANSLATION_DIR = path.join(DATA_DIR, "translation-models");
const LOCAL_PRONUNCIATION_DIR = path.join(DATA_DIR, "pronunciation");
const LOCAL_TRANSLATE_SCRIPT = path.join(APP_ROOT, "local_translate.py");
const LOCAL_DICTIONARY_CACHE = new Map();
const EXPORT_SCRIPT = path.join(APP_ROOT, "export_vocab.py");
const PYTHON_BIN = process.env.PAPER_READER_PYTHON || "python3";
const PORT = Number(process.env.PAPER_READER_PORT || 4317);
const LOCAL_NODE_MODULES = path.join(APP_ROOT, "node_modules");
const BUNDLED_NODE_MODULES = process.env.PAPER_READER_NODE_MODULES || LOCAL_NODE_MODULES;
const PDFJS_ROOT = path.join(
  process.env.PDFJS_ROOT || (await exists(path.join(BUNDLED_NODE_MODULES, "pdfjs-dist")) ? BUNDLED_NODE_MODULES : LOCAL_NODE_MODULES),
  "pdfjs-dist"
);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const KNOWN_SUMMARIES = {
  "s41591-024-03097-1.pdf":
    "评估大语言模型在真实临床决策中的诊断、指南遵循与工作流适配能力，并提出相应的风险缓解方向。",
};

const LOCAL_WORDS = {
  adherence: { pos: "名词", meaning: "遵循；依从；对规则或指南的坚持" },
  autonomous: { pos: "形容词", meaning: "自主的；能够独立完成任务的" },
  pathology: { pos: "名词", meaning: "病理；疾病类型或病变" },
  synthesize: { pos: "动词", meaning: "综合；把不同来源的信息整合起来" },
  robust: { pos: "形容词", meaning: "稳健的；在不同条件下仍然可靠的" },
  workflow: { pos: "名词", meaning: "工作流程；完成一项任务的步骤体系" },
  mitigate: { pos: "动词", meaning: "缓解；减轻风险或不良影响" },
  realistic: { pos: "形容词", meaning: "现实的；接近真实情况的" },
  diagnostic: { pos: "形容词", meaning: "诊断性的；用于判断疾病或问题的" },
  integrate: { pos: "动词", meaning: "整合；使不同部分融为一个整体" },
};

const LOCAL_SENTENCES = [
  {
    match: "clinical decision-making is one of the most impactful parts",
    meaning: "临床决策是医生职责中影响最为深远的部分之一，也尤其有望从人工智能解决方案，特别是大语言模型中获益。",
  },
  {
    match: "current state-of-the-art llms do not accurately diagnose patients",
    meaning: "目前最先进的大语言模型还不能准确地为患者做出诊断。",
  },
  {
    match: "overall, our analysis reveals",
    meaning: "总体而言，我们的分析表明，大语言模型目前还没有准备好承担自主的临床决策工作。",
  },
  {
    match: "while humans primarily interact with the world through language",
    meaning: "由于人类主要通过语言与世界互动，大语言模型有望成为未来多模态医疗人工智能解决方案的重要入口。",
  },
];

await ensureDataFiles();

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDataFiles() {
  await fs.mkdir(PAPERS_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(LOCAL_DICTIONARY_DIR, { recursive: true });
  await fs.mkdir(LOCAL_TRANSLATION_DIR, { recursive: true });
  if (!(await exists(VOCAB_FILE))) await fs.writeFile(VOCAB_FILE, "[]\n", "utf8");
  if (!(await exists(TRANSLATION_CACHE_FILE))) await fs.writeFile(TRANSLATION_CACHE_FILE, "{}\n", "utf8");
  if (!(await exists(SUMMARY_CACHE_FILE))) await fs.writeFile(SUMMARY_CACHE_FILE, "{}\n", "utf8");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function requestMode(req) {
  return req.headers["x-paper-reader-mode"] === "offline" ? "offline" : "online";
}

function cleanText(text) {
  return text
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfMeta(fileName, mode = "online") {
  const filePath = path.join(PAPERS_DIR, fileName);
  let title = fileName.replace(/\.pdf$/i, "");
  let pages = null;
  let size = null;
  try {
    const { stdout } = await execFileAsync("pdfinfo", [filePath], { maxBuffer: 200_000 });
    const titleLine = stdout.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const pagesLine = stdout.match(/^Pages:\s*(\d+)$/m)?.[1];
    if (titleLine) title = titleLine;
    if (pagesLine) pages = Number(pagesLine);
    size = (await fs.stat(filePath)).size;
  } catch {
    // The reader still works if optional PDF metadata tools are unavailable.
  }

  let abstract = "";
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-f", "1", "-l", "2", "-layout", filePath, "-"], {
      maxBuffer: 1_000_000,
    });
    abstract = cleanText(stdout);
  } catch {
    // Keep a short fallback summary below.
  }

  const summary = KNOWN_SUMMARIES[fileName] || await summarizePaper(fileName, title, abstract, mode);
  return {
    id: fileName,
    fileName,
    title,
    summary,
    pages,
    size,
  };
}

function inferSummary(text, title) {
  const abstractMatch = text.match(/(?:abstract|摘要)\s*([\s\S]{80,900}?)(?:\n\s*introduction\b|\n\s*keywords?\b|\n\s*1\s+)/i);
  const candidate = (abstractMatch?.[1] || text.split(/\n\s*\n/)[0] || "").replace(/\s+/g, " ").trim();
  if (candidate) return `围绕该论文主题展开，重点介绍研究问题、方法设计与主要发现。`;
  return `围绕“${title}”展开，重点介绍研究问题、方法设计与主要发现。`;
}

async function remoteSummary(title, abstract) {
  const apiKey = process.env.PAPER_READER_AI_KEY;
  const endpoint = process.env.PAPER_READER_AI_URL;
  if (!apiKey || !endpoint) return null;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.PAPER_READER_AI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "你是论文阅读助手。" },
        { role: "user", content: `请用一句不超过45字的中文概括这篇论文做了什么，只返回 JSON：{"summary":"中文概括"}\n标题：${title}\n摘要：${abstract.slice(0, 5000)}` },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`AI summary returned ${response.status}`);
  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error("AI summary is empty");
  const parsed = JSON.parse(raw);
  return typeof parsed.summary === "string" ? parsed.summary.trim() : null;
}

async function summarizePaper(fileName, title, abstract, mode = "online") {
  const cache = await readJson(SUMMARY_CACHE_FILE, {});
  if (cache[fileName]) return cache[fileName];
  let summary = null;
  if (mode !== "offline") {
    try {
      summary = await remoteSummary(title, abstract);
    } catch (error) {
      console.warn("AI summary unavailable:", error.message);
    }
  }
  summary ||= inferSummary(abstract, title);
  cache[fileName] = summary;
  await writeJson(SUMMARY_CACHE_FILE, cache);
  return summary;
}

async function listPapers(mode = "online") {
  const names = (await fs.readdir(PAPERS_DIR)).filter((name) => name.toLowerCase().endsWith(".pdf"));
  return Promise.all(names.map((name) => pdfMeta(name, mode)));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeWord(text) {
  return text.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
}

function formatDictionaryPos(pos) {
  const labels = {
    n: "名词",
    v: "动词",
    a: "形容词",
    s: "形容词",
    ad: "副词",
    adv: "副词",
    prep: "介词",
    pron: "代词",
    conj: "连词",
    aux: "助动词",
    int: "感叹词",
    art: "冠词",
    article: "冠词",
  };
  const values = String(pos || "")
    .split(/[\s/]+/)
    .map((value) => value.replace(/\.$/, "").toLowerCase())
    .filter(Boolean)
    .map((value) => labels[value] || value);
  return [...new Set(values)].join(" / ") || "语境词性";
}

function inferDictionaryPos(entry) {
  if (entry.posLabel && entry.posLabel !== "语境词性") return entry.posLabel;
  const match = `${entry.translation || ""}\n${entry.definition || ""}`.match(/(?:^|\n)\s*(n|v|a|s|ad|adv|prep|pron|conj|aux|int|art|article)\./i);
  return match ? formatDictionaryPos(match[1]) : "语境词性";
}

async function lookupLocalDictionary(word) {
  const normalized = normalizeWord(word);
  const first = normalized[0];
  if (!first || !/^[a-z]$/i.test(first)) return null;
  if (!LOCAL_DICTIONARY_CACHE.has(first)) {
    const filePath = path.join(LOCAL_DICTIONARY_DIR, `${first}.json`);
    LOCAL_DICTIONARY_CACHE.set(first, await readJson(filePath, {}));
  }
  const entries = LOCAL_DICTIONARY_CACHE.get(first);
  return entries[normalized] || null;
}

function pronunciationAudio(word) {
  const normalized = normalizeWord(word);
  if (!normalized) return "";
  // 浏览器只请求本地同源地址，由服务端代理远程音频，避免跨域播放失败。
  return `/api/pronunciation?word=${encodeURIComponent(normalized)}`;
}

async function localTranslation(text, type) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (type === "word") {
    const word = normalizeWord(text);
    const entry = (await lookupLocalDictionary(word)) || LOCAL_WORDS[word];
    if (entry) {
      return {
        pos: inferDictionaryPos(entry),
        meaning: entry.translation || entry.meaning || entry.definition || "本地词典暂未提供中文释义。",
        example: entry.example || "",
        phonetic: entry.phonetic || "",
        audio: pronunciationAudio(word),
        mode: entry.translation ? "local-dictionary" : "local",
        provider: entry.translation ? "本地英汉词典" : undefined,
      };
    }
    try {
      const meaning = await localModelTranslation(text);
      if (meaning && meaning.toLowerCase() !== word) {
        return {
          pos: "根据语境判断",
          meaning,
          audio: pronunciationAudio(word),
          mode: "local-model",
          provider: "本地 Argos Translate",
        };
      }
    } catch (error) {
      console.warn("Local word translation unavailable:", error.message);
    }
    return {
      pos: "根据语境判断",
      meaning: "本地词典暂未收录该词。你可以在设置中接入 AI 翻译，以获得词性、语境义和例句。",
      mode: "local",
    };
  }
  const known = LOCAL_SENTENCES.find((item) => normalized.includes(item.match) || item.match.includes(normalized));
  return {
    meaning: known?.meaning || "本地模式已识别这段英文。接入 AI 后，这里会显示针对所选多句或多段内容的完整中文意思。",
    note: known ? "这是按当前段落语境整理的自然译文。" : "原文没有被改动，中文只在本次选区中临时显示。",
    mode: "local",
  };
}

async function remoteTranslation(text, type) {
  const apiKey = process.env.PAPER_READER_AI_KEY;
  const endpoint = process.env.PAPER_READER_AI_URL;
  if (!apiKey || !endpoint) return null;
  const prompt = type === "word"
    ? `请分析这个英文论文词汇：${text}。只返回 JSON：{"pos":"中文词性","meaning":"当前学术语境下的完整中文意思","example":"一个很短的英文例句"}。`
    : `请把下面选中的英文论文内容翻译成自然、完整、易懂的中文。可以跨句和跨段，保持原意，不要逐词硬译。只返回 JSON：{"meaning":"中文译文","note":"一句话说明句子逻辑"}。\n\n${text}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.PAPER_READER_AI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "你是严格、清晰的医学论文英语教练。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.15,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`AI service returned ${response.status}`);
  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error("AI response is empty");
  return { ...JSON.parse(raw), mode: "remote" };
}

async function localModelTranslation(text) {
  if (!(await exists(LOCAL_TRANSLATE_SCRIPT))) return null;
  const { stdout } = await execFileAsync(PYTHON_BIN, [LOCAL_TRANSLATE_SCRIPT, text], {
    env: {
      ...process.env,
      ARGOS_PACKAGES_DIR: process.env.PAPER_READER_ARGOS_PACKAGES_DIR || LOCAL_TRANSLATION_DIR,
    },
    timeout: 120_000,
    maxBuffer: 2_000_000,
  });
  const payload = JSON.parse(stdout.trim());
  if (!payload.translation) throw new Error("本地翻译没有返回内容");
  return payload.translation;
}

async function localLongTextTranslation(text) {
  const chunks = splitTranslationChunks(text, 1200);
  const translations = [];
  for (const chunk of chunks) {
    const translation = await localModelTranslation(chunk);
    if (!translation?.trim()) throw new Error("本地翻译没有返回内容");
    translations.push(translation.trim());
  }
  return translations.join("\n\n");
}

const PUBLIC_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const BACKUP_TRANSLATE_ENDPOINT = "https://lingva.ml/api/v1";
const PUBLIC_DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en";
const PARTS_OF_SPEECH = {
  noun: "名词",
  verb: "动词",
  adjective: "形容词",
  adverb: "副词",
  pronoun: "代词",
  preposition: "介词",
  conjunction: "连词",
  interjection: "感叹词",
  determiner: "限定词",
  article: "冠词",
  auxiliary: "助动词",
  modal: "情态动词",
};

function splitTranslationChunks(text, maxLength = 1600) {
  const pieces = text.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g)?.filter(Boolean) || [text];
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    if ((current + piece).length <= maxLength) {
      current += piece;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    if (piece.length <= maxLength) {
      current = piece;
      continue;
    }
    let remainder = piece;
    while (remainder.length > maxLength) {
      const cut = remainder.lastIndexOf(" ", maxLength);
      const splitAt = cut > 200 ? cut : maxLength;
      chunks.push(remainder.slice(0, splitAt).trim());
      remainder = remainder.slice(splitAt);
    }
    current = remainder;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

async function translateWithGoogle(text) {
  const url = new URL(PUBLIC_TRANSLATE_ENDPOINT);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", "zh-CN");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  const response = await fetch(url, { headers: { "user-agent": "paper-reader/1.0" } });
  if (!response.ok) throw new Error(`在线翻译返回 ${response.status}`);
  const payload = await response.json();
  const translated = Array.isArray(payload?.[0])
    ? payload[0].map((segment) => segment?.[0] || "").join("").trim()
    : "";
  if (!translated) throw new Error("在线翻译没有返回内容");
  return translated;
}

async function translateWithLingva(text) {
  const url = `${BACKUP_TRANSLATE_ENDPOINT}/en/zh/${encodeURIComponent(text)}`;
  const response = await fetch(url, { headers: { "user-agent": "paper-reader/1.0" } });
  if (!response.ok) throw new Error(`备用在线翻译返回 ${response.status}`);
  const payload = await response.json();
  const translated = typeof payload?.translation === "string" ? payload.translation.trim() : "";
  if (!translated) throw new Error("备用在线翻译没有返回内容");
  return translated;
}

async function translateLongText(text) {
  const chunks = splitTranslationChunks(text);
  const translated = [];
  for (const chunk of chunks) {
    try {
      translated.push(await translateWithGoogle(chunk));
    } catch (googleError) {
      try {
        translated.push(await translateWithLingva(chunk));
      } catch (backupError) {
        throw new Error(`${googleError.message}; ${backupError.message}`);
      }
    }
  }
  return translated.join("\n");
}

async function lookupDictionaryWord(word) {
  const response = await fetch(`${PUBLIC_DICTIONARY_ENDPOINT}/${encodeURIComponent(word)}`, {
    headers: { "user-agent": "paper-reader/1.0" },
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const entry = payload.find((item) => item?.meanings?.length);
  const meaning = entry?.meanings?.find((item) => item?.definitions?.length);
  const definition = meaning?.definitions?.[0];
  if (!definition) return null;
  const audio = payload.flatMap((item) => item?.phonetics || []).find((item) => item?.audio)?.audio || "";
  return {
    pos: PARTS_OF_SPEECH[meaning.partOfSpeech] || meaning.partOfSpeech || "语境词性",
    definition: definition.definition || "",
    example: definition.example || "",
    audio,
  };
}

async function publicWordTranslation(text) {
  const word = normalizeWord(text);
  const [translatedResult, dictionaryResult] = await Promise.allSettled([
    translateLongText(word),
    lookupDictionaryWord(word),
  ]);
  const directMeaning = translatedResult.status === "fulfilled" ? translatedResult.value : "";
  const dictionary = dictionaryResult.status === "fulfilled" ? dictionaryResult.value : null;
  let meaning = directMeaning;
  if (dictionary?.definition) {
    try {
      const definition = await translateLongText(dictionary.definition);
      meaning = meaning ? `${meaning}；${definition}` : definition;
    } catch {
      // Direct translation is still useful when the dictionary definition cannot be translated.
    }
  }
  if (!meaning) throw new Error("在线词典暂时没有返回结果");
  return {
    pos: dictionary?.pos || "语境词性",
    meaning,
    example: dictionary?.example || "",
    audio: pronunciationAudio(word),
    mode: "online",
    provider: "在线翻译",
  };
}

async function publicTranslation(text, type) {
  if (type === "word") return publicWordTranslation(text);
  return {
    meaning: await translateLongText(text),
    note: "在线翻译已完成；原文没有被改动，中文只在本次选区中显示。",
    mode: "online",
    provider: "在线翻译",
  };
}

function isPlaceholderTranslation(result) {
  return /本地词典暂未收录|本地模式已识别这段英文/.test(result?.meaning || "");
}

async function translate(text, type, mode = "online") {
  const cache = await readJson(TRANSLATION_CACHE_FILE, {});
  const key = `${type}:${text.trim().toLowerCase()}`;
  const offline = mode === "offline";
  const cached = cache[key];
  const staleLocalPlaceholder = cached?.mode === "local" && !cached?.provider;
  const cachedOnline = cached?.mode === "online" || cached?.mode === "remote";
  const cachedLocal = cached?.mode === "local" || cached?.mode === "local-model" || cached?.mode === "local-dictionary";
  if (cached && !isPlaceholderTranslation(cached) && !staleLocalPlaceholder && !(offline && cachedOnline) && !(mode === "online" && cachedLocal)) {
    const cachedResult = { ...cached, cached: true };
    if (type === "word") {
      cachedResult.audio = pronunciationAudio(text);
      cache[key] = cachedResult;
      await writeJson(TRANSLATION_CACHE_FILE, cache);
    }
    return cachedResult;
  }
  let result;
  if (type === "sentence" && offline) {
    try {
      const meaning = await localLongTextTranslation(text);
      if (meaning) {
        result = {
          meaning,
          note: "本地翻译已完成；原文没有被改动，中文只在本次选区中显示。",
          mode: "local-model",
          provider: "本地 Argos Translate",
        };
      }
    } catch (error) {
      console.warn("Local translation unavailable:", error.message);
    }
  }
  if (!result && !offline) {
    try {
      result = await remoteTranslation(text, type);
    } catch (error) {
      result = null;
      console.warn("AI translation unavailable:", error.message);
    }
    if (!result) {
      try {
        result = await publicTranslation(text, type);
      } catch (error) {
        result = null;
        console.warn("Online translation unavailable:", error.message);
      }
    }
  }
  if (!result && type === "sentence") {
    try {
      const meaning = await localLongTextTranslation(text);
      if (meaning) {
        result = {
          meaning,
          note: "本地翻译已完成；原文没有被改动，中文只在本次选区中显示。",
          mode: "local-model",
          provider: "本地 Argos Translate",
        };
      }
    } catch (error) {
      console.warn("Local translation fallback unavailable:", error.message);
    }
  }
  result ||= await localTranslation(text, type);
  if (type === "word" && !result.audio) result.audio = pronunciationAudio(text);
  cache[key] = result;
  await writeJson(TRANSLATION_CACHE_FILE, cache);
  return result;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function servePdf(res, fileName, req) {
  const safeName = path.basename(fileName);
  if (!safeName.toLowerCase().endsWith(".pdf")) return json(res, 404, { error: "PDF not found" });
  const filePath = path.join(PAPERS_DIR, safeName);
  if (!(await exists(filePath))) return json(res, 404, { error: "PDF not found" });
  const stat = await fs.stat(filePath);
  const range = req.headers.range;
  res.setHeader("content-type", "application/pdf");
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "no-cache");
  if (!range) {
    res.setHeader("content-length", stat.size);
    createReadStream(filePath).pipe(res);
    return;
  }
  const [startText, endText] = range.replace(/bytes=/, "").split("-");
  const start = Number(startText) || 0;
  const end = endText ? Math.min(Number(endText), stat.size - 1) : stat.size - 1;
  res.writeHead(206, {
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

async function serveLocalPronunciation(res, normalized) {
  const outputPath = path.join(LOCAL_PRONUNCIATION_DIR, `${normalized}.m4a`);
  if (!(await exists(outputPath))) {
    await fs.mkdir(LOCAL_PRONUNCIATION_DIR, { recursive: true });
    const stamp = `${normalized}-${Date.now()}`;
    const sourcePath = path.join(LOCAL_PRONUNCIATION_DIR, `${stamp}.aiff`);
    try {
      await execFileAsync("say", ["-v", "Samantha", "-o", sourcePath, normalized], { timeout: 20_000 });
      await execFileAsync("afconvert", ["-f", "m4af", "-d", "aac", sourcePath, outputPath], { timeout: 20_000 });
    } finally {
      await fs.unlink(sourcePath).catch(() => {});
    }
  }
  const stat = await fs.stat(outputPath);
  res.writeHead(200, {
    "content-type": "audio/mp4",
    "content-length": stat.size,
    "cache-control": "public, max-age=31536000, immutable",
  });
  createReadStream(outputPath).pipe(res);
}

async function servePronunciation(res, word, mode = "online") {
  const normalized = normalizeWord(word || "");
  if (!normalized) return json(res, 400, { error: "word is required" });
  if (mode === "offline") return serveLocalPronunciation(res, normalized);
  const url = new URL("https://translate.google.com/translate_tts");
  url.searchParams.set("ie", "UTF-8");
  url.searchParams.set("client", "tw-ob");
  url.searchParams.set("tl", "en");
  url.searchParams.set("q", normalized);
  const response = await fetch(url, { headers: { "user-agent": "paper-reader/1.0" } });
  if (!response.ok) return json(res, 502, { error: "pronunciation unavailable" });
  const audio = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    "content-type": response.headers.get("content-type") || "audio/mpeg",
    "content-length": audio.length,
    "cache-control": "public, max-age=86400",
  });
  res.end(audio);
}

async function exportVocabulary(res, payload) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputPath = path.join(DATA_DIR, `vocab-export-${stamp}.json`);
  const outputPath = path.join(DATA_DIR, `vocab-export-${stamp}.docx`);
  try {
    await writeJson(inputPath, payload || { groups: [], words: [] });
    await execFileAsync(PYTHON_BIN, [EXPORT_SCRIPT, inputPath, outputPath], { maxBuffer: 1_000_000 });
    const document = await fs.readFile(outputPath);
    res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-length": document.length,
      "content-disposition": "attachment; filename=mo-reader-vocabulary.docx; filename*=UTF-8''%E5%A2%A8%E8%AF%BB-%E7%94%9F%E8%AF%8D%E6%9C%AC.docx",
      "cache-control": "no-store",
    });
    res.end(document);
  } finally {
    await Promise.allSettled([fs.unlink(inputPath), fs.unlink(outputPath)]);
  }
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.resolve(APP_ROOT, relative);
  if (!filePath.startsWith(APP_ROOT) || !(await exists(filePath))) return json(res, 404, { error: "Not found" });
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return json(res, 404, { error: "Not found" });
  res.writeHead(200, { "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

async function servePdfJs(res, urlPath) {
  const relative = urlPath.replace(/^\/vendor\/pdfjs\//, "");
  const filePath = path.resolve(PDFJS_ROOT, relative);
  if (!filePath.startsWith(PDFJS_ROOT) || !(await exists(filePath))) return json(res, 404, { error: "PDF.js not found" });
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/papers" && req.method === "GET") return json(res, 200, { papers: await listPapers(requestMode(req)) });
    if (url.pathname === "/api/vocab" && req.method === "GET") return json(res, 200, { words: await readJson(VOCAB_FILE, []) });
    if (url.pathname === "/api/vocab/export" && req.method === "POST") {
      return exportVocabulary(res, await readBody(req));
    }
    if (url.pathname === "/api/vocab" && req.method === "POST") {
      const entry = await readBody(req);
      const words = await readJson(VOCAB_FILE, []);
      const normalized = normalizeWord(entry.word || "");
      if (!normalized) return json(res, 400, { error: "word is required" });
      const next = {
        id: `${normalized}-${Date.now()}`,
        word: normalized,
        pos: entry.pos || "",
        meaning: entry.meaning || "",
        sourceTitle: entry.sourceTitle || "",
        createdAt: new Date().toISOString(),
      };
      const withoutDuplicate = words.filter((item) => item.word !== normalized);
      await writeJson(VOCAB_FILE, [next, ...withoutDuplicate]);
      return json(res, 200, { word: next });
    }
    if (url.pathname === "/api/translate" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.text?.trim()) return json(res, 400, { error: "text is required" });
      return json(res, 200, await translate(body.text, body.type === "word" ? "word" : "sentence", requestMode(req)));
    }
    if (url.pathname === "/api/pronunciation" && req.method === "GET") {
      const mode = url.searchParams.get("mode") === "offline" ? "offline" : requestMode(req);
      return servePronunciation(res, url.searchParams.get("word") || "", mode);
    }
    if (url.pathname.startsWith("/api/summary") && req.method === "POST") {
      return json(res, 200, { summary: "论文中文概括会在接入 AI 后自动生成；当前已提供首篇论文的精炼概括。" });
    }
    if (url.pathname.startsWith("/vendor/pdfjs/")) return servePdfJs(res, url.pathname);
    if (url.pathname.startsWith("/pdf/")) return servePdf(res, decodeURIComponent(url.pathname.slice(5)), req);
    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Paper Reader is running at http://127.0.0.1:${PORT}`);
  console.log(`Translation: ${process.env.PAPER_READER_AI_KEY && process.env.PAPER_READER_AI_URL ? "remote AI + local model + online fallback" : "local model + online fallback + local dictionary"}`);
});
