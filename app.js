import * as pdfjsLib from "/vendor/pdfjs/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  mode: localStorage.getItem("mo-reader-mode") || "online",
  papers: [],
  vocabulary: [],
  currentPaper: null,
  currentPdf: null,
  currentSelection: null,
  lastSelectionKey: "",
  searchMatches: [],
  searchQuery: "",
  searchRequestId: 0,
  vocabSelectedDates: new Set(),
  vocabSelectionInitialized: false,
  pronunciationAudio: null,
  pronunciationUtterance: null,
  pronunciationKey: "",
};
const selectionGesture = { start: null, end: null, active: false };

const els = {
  modeGate: $("#mode-gate"),
  modeStatus: $("#mode-status"),
  modeChip: $("#mode-chip"),
  libraryView: $("#library-view"),
  readerView: $("#reader-view"),
  vocabView: $("#vocabulary-view"),
  paperGrid: $("#paper-grid"),
  vocabList: $("#vocab-list"),
  paperCount: $("#paper-count"),
  vocabCount: $("#vocab-count"),
  statPapers: $("#stat-papers"),
  statWords: $("#stat-words"),
  vocabTotal: $("#vocab-total"),
  vocabSelectionSummary: $("#vocab-selection-summary"),
  vocabExport: $("#vocab-export"),
  recentList: $("#recent-list"),
  topbarContext: $("#topbar-context"),
  readerTitle: $("#reader-title"),
  sidePaperTitle: $("#side-paper-title"),
  sidePaperSummary: $("#side-paper-summary"),
  sidePageCount: $("#side-page-count"),
  pdfScroll: $("#pdf-scroll"),
  readerLoading: $("#reader-loading"),
  explainPopover: $("#explain-popover"),
  popoverType: $("#popover-type"),
  popoverStatus: $("#popover-status"),
  selectionQuote: $("#selection-quote"),
  popoverResult: $("#popover-result"),
  popoverActions: $("#popover-actions"),
  searchInput: $("#paper-search-input"),
  searchSubmit: $("#paper-search-submit"),
  searchResults: $("#paper-search-results"),
  toast: $("#toast"),
};

const modeLabels = { online: "在线模式", offline: "离线模式" };

function updateModeUI() {
  const label = modeLabels[state.mode] || "未选择模式";
  if (els.modeStatus) els.modeStatus.textContent = label;
  if (els.modeChip) els.modeChip.title = `当前：${label}，点击切换`;
}

function showModeGate() {
  els.modeGate?.classList.remove("hidden");
}

async function chooseMode(mode) {
  state.mode = mode;
  localStorage.setItem("mo-reader-mode", mode);
  updateModeUI();
  els.modeGate?.classList.add("hidden");
  try {
    await loadLibrary();
  } catch (error) {
    els.paperGrid.innerHTML = `<div class="empty-state">无法连接论文库：${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function formatDate(value) {
  if (!value) return "刚刚加入";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function vocabDateKey(item) {
  const date = item.createdAt ? new Date(item.createdAt) : new Date();
  if (Number.isNaN(date.getTime())) return vocabDateKey({});
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateKey() {
  return vocabDateKey({ createdAt: new Date().toISOString() });
}

function vocabDateLabel(dateKey) {
  if (dateKey === todayDateKey()) return "今天";
  const [year, month, day] = dateKey.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function groupedVocabulary() {
  const groups = new Map();
  state.vocabulary.forEach((item) => {
    const dateKey = vocabDateKey(item);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push({ ...item, dateKey });
  });
  return [...groups.entries()]
    .sort(([first], [second]) => second.localeCompare(first))
    .map(([dateKey, words]) => ({ dateKey, label: vocabDateLabel(dateKey), words }));
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), 2400);
}

function stopPronunciation() {
  state.pronunciationAudio?.pause();
  state.pronunciationAudio = null;
  state.pronunciationUtterance = null;
  state.pronunciationKey = "";
  window.speechSynthesis?.cancel();
}

function speakWordFallback(word) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = 0.86;
  utterance.pitch = 1;
  state.pronunciationUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

function playWordPronunciation(word) {
  const normalized = word.trim().toLowerCase();
  if (!normalized || state.pronunciationKey === normalized) return;
  stopPronunciation();
  state.pronunciationKey = normalized;
  const modeQuery = state.mode === "offline" ? "&mode=offline" : "";
  const audio = new Audio(`/api/pronunciation?word=${encodeURIComponent(normalized)}${modeQuery}`);
  audio.preload = "auto";
  audio.addEventListener("ended", () => { state.pronunciationAudio = null; }, { once: true });
  audio.addEventListener("error", () => {
    if (state.pronunciationAudio !== audio) return;
    state.pronunciationAudio = null;
    speakWordFallback(normalized);
  }, { once: true });
  state.pronunciationAudio = audio;
  audio.play().catch(() => {
    if (state.pronunciationAudio !== audio) return;
    state.pronunciationAudio = null;
    speakWordFallback(normalized);
  });
}

async function requestJson(url, options) {
  const headers = new Headers(options?.headers || {});
  headers.set("x-paper-reader-mode", state.mode || "online");
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function loadLibrary() {
  const [paperPayload, vocabPayload] = await Promise.all([
    requestJson("/api/papers"),
    requestJson("/api/vocab"),
  ]);
  state.papers = paperPayload.papers || [];
  state.vocabulary = vocabPayload.words || [];
  renderLibrary();
  renderVocabulary();
  renderRecent();
}

function renderLibrary() {
  els.paperCount.textContent = state.papers.length;
  els.statPapers.textContent = state.papers.length;
  els.vocabCount.textContent = state.vocabulary.length;
  els.statWords.textContent = state.vocabulary.length;
  if (!state.papers.length) {
    els.paperGrid.innerHTML = `<div class="empty-state">暂时还没有 PDF。把论文放进当前文件夹，然后点击“刷新论文库”。</div>`;
    return;
  }
  els.paperGrid.innerHTML = state.papers.map((paper) => `
    <article class="paper-card" data-paper-id="${escapeHtml(paper.id)}">
      <div class="paper-card-top"><span class="paper-type">PDF · ${paper.pages || "—"} 页</span><span class="paper-card-more">···</span></div>
      <h3>${escapeHtml(paper.title)}</h3>
      <p class="paper-card-summary">${escapeHtml(paper.summary)}</p>
      <div class="paper-card-footer"><span>${paper.size ? `${Math.round(paper.size / 1024 / 1024 * 10) / 10} MB` : "PDF 文件"}</span><span>打开阅读 →</span></div>
    </article>
  `).join("");
  $$(".paper-card").forEach((card) => card.addEventListener("click", () => openReader(card.dataset.paperId)));
}

function renderRecent() {
  const ids = JSON.parse(localStorage.getItem("paper-reader-recent") || "[]");
  const recentPapers = ids.map((id) => state.papers.find((paper) => paper.id === id)).filter(Boolean).slice(0, 4);
  els.recentList.innerHTML = recentPapers.length
    ? recentPapers.map((paper) => `<div class="recent-item" data-paper-id="${escapeHtml(paper.id)}">${escapeHtml(paper.title)}</div>`).join("")
    : `<div class="recent-item" style="cursor:default;color:#587667">还没有阅读记录</div>`;
  $$(".recent-item[data-paper-id]").forEach((item) => item.addEventListener("click", () => openReader(item.dataset.paperId)));
}

function rememberRecent(paperId) {
  const ids = JSON.parse(localStorage.getItem("paper-reader-recent") || "[]");
  localStorage.setItem("paper-reader-recent", JSON.stringify([paperId, ...ids.filter((id) => id !== paperId)].slice(0, 6)));
  renderRecent();
}

function switchView(view) {
  if (view !== "reader") resetPaperSearch();
  els.libraryView.classList.toggle("hidden", view !== "library");
  els.readerView.classList.toggle("hidden", view !== "reader");
  els.vocabView.classList.toggle("hidden", view !== "vocabulary");
  document.body.classList.toggle("reader-mode", view === "reader");
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  els.topbarContext.textContent = view === "library" ? "论文库" : view === "vocabulary" ? "生词本" : "正在阅读";
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function openReader(paperId) {
  const paper = state.papers.find((candidate) => candidate.id === paperId);
  if (!paper) return;
  state.currentPaper = paper;
  rememberRecent(paper.id);
  switchView("reader");
  els.readerTitle.textContent = paper.title;
  els.sidePaperTitle.textContent = paper.title;
  els.sidePaperSummary.textContent = paper.summary;
  els.sidePageCount.textContent = paper.pages ? `${paper.pages} 页` : "PDF";
  resetPaperSearch();
  els.pdfScroll.innerHTML = "";
  els.readerLoading.classList.remove("hidden");
  closePopover();
  try {
    state.currentPdf = await pdfjsLib.getDocument(`/pdf/${encodeURIComponent(paper.fileName)}`).promise;
    for (let pageNumber = 1; pageNumber <= state.currentPdf.numPages; pageNumber += 1) {
      await renderPdfPage(pageNumber);
    }
    els.readerLoading.classList.add("hidden");
  } catch (error) {
    els.readerLoading.innerHTML = `<div style="font-size:28px;margin-bottom:6px">⌁</div><span>这篇 PDF 暂时无法打开：${escapeHtml(error.message)}</span>`;
  }
}

async function renderPdfPage(pageNumber) {
  const page = await state.currentPdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(300, els.pdfScroll.clientWidth - 28);
  const targetWidth = Math.min(760, availableWidth);
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const wrapper = document.createElement("div");
  wrapper.className = "pdf-page";
  wrapper.dataset.pageNumber = pageNumber;
  wrapper.style.width = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;
  const canvas = document.createElement("canvas");
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  wrapper.appendChild(canvas);
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;
  wrapper.appendChild(textLayer);
  els.pdfScroll.appendChild(wrapper);

  const context = canvas.getContext("2d", { alpha: false });
  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
  const textContent = await page.getTextContent();
  buildSelectableTextLayer(textLayer, textContent, viewport);
}

function buildSelectableTextLayer(textLayer, textContent, viewport) {
  for (const item of textContent.items) {
    if (!item.str) continue;
    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(transform[1], transform[0]);
    const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
    const scaleX = Math.max(0.2, Math.hypot(transform[0], transform[1]) / fontHeight);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${transform[4]}px`;
    span.style.top = `${transform[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.height = `${fontHeight}px`;
    span.style.transform = `rotate(${angle}rad) scaleX(${scaleX})`;
    textLayer.appendChild(span);
  }
}

function nodeInTextLayer(node) {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(".textLayer");
}

function classifySelection(text) {
  const normalized = text.trim();
  return /^[A-Za-z][A-Za-z'’\-]*$/.test(normalized) ? "word" : "sentence";
}

function normalizeSelectedText(text) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function selectedTextWithLayout(range) {
  const layer = nodeInTextLayer(range?.startContainer);
  const endLayer = nodeInTextLayer(range?.endContainer);
  if (!layer || layer !== endLayer) return normalizeSelectedText(range?.toString() || "");

  const pieces = [];
  let previous = null;
  [...layer.querySelectorAll("span")].forEach((span) => {
    if (!range.intersectsNode(span)) return;
    const spanRange = document.createRange();
    spanRange.selectNodeContents(span);
    const pieceRange = range.cloneRange();
    if (pieceRange.compareBoundaryPoints(Range.START_TO_START, spanRange) < 0) {
      pieceRange.setStart(spanRange.startContainer, spanRange.startOffset);
    }
    if (pieceRange.compareBoundaryPoints(Range.END_TO_END, spanRange) > 0) {
      pieceRange.setEnd(spanRange.endContainer, spanRange.endOffset);
    }
    const text = pieceRange.toString();
    if (!text) return;

    if (previous) {
      const previousRect = previous.span.getBoundingClientRect();
      const currentRect = span.getBoundingClientRect();
      const fontHeight = Math.max(previousRect.height, currentRect.height, 1);
      const sameLine = Math.abs(previousRect.top - currentRect.top) < fontHeight * 0.45;
      const gap = currentRect.left - previousRect.right;
      const hasWordCharacters = /[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(text);
      if (hasWordCharacters && (!sameLine || gap > Math.max(1, fontHeight * 0.12))) {
        pieces.push(sameLine ? " " : "\n");
      }
    }
    pieces.push(text);
    previous = { span, text };
  });
  return normalizeSelectedText(pieces.join(""));
}

function positionPopover(rect) {
  const popover = els.explainPopover;
  const margin = 16;
  const width = popover.offsetWidth || 548;
  const height = popover.offsetHeight || 220;
  // 优先紧贴选区右侧，其次放到左侧；只有左右都放不下时才上下放置。
  // 这样翻译始终能和当前选区建立清晰的视觉对应关系。
  const rightSide = rect.right + 12;
  const leftSide = rect.left - width - 12;
  let left;
  let top;
  if (rightSide + width <= window.innerWidth - margin) {
    left = rightSide;
    top = Math.max(margin, Math.min(window.innerHeight - height - margin, rect.top));
  } else if (leftSide >= margin) {
    left = leftSide;
    top = Math.max(margin, Math.min(window.innerHeight - height - margin, rect.top));
  } else if (rect.bottom + 12 + height <= window.innerHeight - margin) {
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left));
    top = rect.bottom + 12;
  } else {
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left));
    top = Math.max(margin, rect.top - height - 12);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function selectedTextFromPage() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!nodeInTextLayer(range.startContainer) || !nodeInTextLayer(range.endContainer)) return null;
  const text = selectedTextWithLayout(range);
  if (!text) return null;
  return { text, type: classifySelection(text), rect: range.getBoundingClientRect(), range };
}

function caretRangeAtPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const position = document.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function clearSelectionMarkers() {
  $$(".selection-marker").forEach((marker) => marker.remove());
}

function addSelectionMarker(layer, rect) {
  if (!layer || !rect?.width || !rect?.height) return;
  const layerRect = layer.getBoundingClientRect();
  const marker = document.createElement("i");
  marker.className = "selection-marker";
  marker.style.left = `${rect.left - layerRect.left}px`;
  marker.style.top = `${rect.bottom - layerRect.top - 1}px`;
  marker.style.width = `${Math.max(3, rect.width)}px`;
  layer.appendChild(marker);
}

function markSelection(selected) {
  clearSelectionMarkers();
  if (selected.spans?.length) {
    selected.spans.forEach((span) => addSelectionMarker(span.closest(".textLayer"), span.getBoundingClientRect()));
    return;
  }
  const range = selected.range || window.getSelection()?.rangeCount && window.getSelection().getRangeAt(0);
  const fallbackLayer = range && nodeInTextLayer(range.startContainer);
  if (!fallbackLayer || !range) return;
  const rects = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const mergedRects = [];
  rects.forEach((rect) => {
    const current = mergedRects[mergedRects.length - 1];
    // PDF.js 不同 span 的 transform 可能造成几像素的垂直误差，放宽合并范围，
    // 避免同一行被画成两条错开的下划线。
    const sameLine = current && Math.abs(current.top - rect.top) < 8;
    const closeEnough = current && rect.left - current.right < 24;
    if (sameLine && closeEnough) {
      current.right = Math.max(current.right, rect.right);
      current.bottom = Math.max(current.bottom, rect.bottom);
      return;
    }
    mergedRects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  });
  mergedRects.forEach((rect) => {
    const layer = $$(".textLayer").find((candidate) => {
      const layerRect = candidate.getBoundingClientRect();
      return rect.left >= layerRect.left - 1 && rect.right <= layerRect.right + 1 && rect.top >= layerRect.top - 1 && rect.bottom <= layerRect.bottom + 1;
    }) || fallbackLayer;
    addSelectionMarker(layer, { ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top });
  });
}

function wordFromSpanAtPoint(span, x) {
  const text = span?.textContent || "";
  if (!text) return "";
  const offset = textOffsetAtPoint(span, x);
  const words = [...text.matchAll(/[A-Za-z][A-Za-z'’\-]*/g)];
  const match = words.find((item) => offset >= item.index && offset <= item.index + item[0].length) || words[0];
  return match?.[0] || "";
}

function wordRangeAtPoint(span, x, y) {
  const textNode = span?.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !span?.contains(textNode)) return null;
  const text = textNode.textContent || "";
  const offset = textOffsetAtPoint(span, x);
  const words = [...text.matchAll(/[A-Za-z][A-Za-z'’\-]*/g)];
  const match = words.find((item) => offset >= item.index && offset <= item.index + item[0].length)
    || words.reduce((nearest, item) => Math.abs(item.index - offset) < Math.abs(nearest.index - offset) ? item : nearest, words[0]);
  if (!match) return null;
  const range = document.createRange();
  range.setStart(textNode, match.index);
  range.setEnd(textNode, match.index + match[0].length);
  return { text: match[0], range };
}

function textOffsetAtPoint(span, x) {
  const textNode = span?.firstChild;
  const text = textNode?.textContent || "";
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !text) return 0;

  // PDF.js 的文字层通常通过 transform 缩放 span，直接用 span 宽度按比例换算
  // 会在单词末尾少算一个字符。逐字符测量可以得到真实的视觉落点。
  const characterRange = document.createRange();
  for (let offset = 0; offset < text.length; offset += 1) {
    characterRange.setStart(textNode, offset);
    characterRange.setEnd(textNode, offset + 1);
    const rect = characterRange.getBoundingClientRect();
    if (!rect.width) continue;
    const middle = rect.left + rect.width / 2;
    if (x < middle) return offset;
    if (x <= rect.right + 0.5) return offset + 1;
  }

  return text.length;
}

function manualSelectionFromGesture() {
  const start = selectionGesture.start;
  const end = selectionGesture.end;
  selectionGesture.start = null;
  selectionGesture.end = null;
  if (!start || !end) return null;
  const startSpan = start.target?.closest?.(".textLayer span");
  const endSpan = end.target?.closest?.(".textLayer span");
  if (!startSpan || !endSpan || startSpan.closest(".textLayer") !== endSpan.closest(".textLayer")) return null;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 8) {
    const exactWord = wordRangeAtPoint(startSpan, start.x, start.y);
    if (exactWord) return { text: exactWord.text, type: "word", rect: exactWord.range.getBoundingClientRect(), range: exactWord.range };
    const word = wordFromSpanAtPoint(startSpan, start.x);
    return word ? { text: word, type: "word", rect: startSpan.getBoundingClientRect(), spans: [startSpan] } : null;
  }

  const layer = startSpan.closest(".textLayer");
  const spans = [...layer.querySelectorAll("span")];
  const startIndex = spans.indexOf(startSpan);
  const endIndex = spans.indexOf(endSpan);
  if (startIndex < 0 || endIndex < 0) return null;
  const startTextNode = startSpan.firstChild;
  const endTextNode = endSpan.firstChild;
  if (startTextNode?.nodeType !== Node.TEXT_NODE || endTextNode?.nodeType !== Node.TEXT_NODE) return null;

  // caretRangeFromPoint 在 PDF.js 的透明文字层上偶尔拿不到位置；用每个字符的
  // 实际视觉边界补算字符偏移，但仍然只建立到字符级的 Range，不再整段吞掉。
  const startOffset = textOffsetAtPoint(startSpan, start.x);
  const endOffset = textOffsetAtPoint(endSpan, end.x);
  const range = document.createRange();
  if (startIndex < endIndex || (startIndex === endIndex && startOffset <= endOffset)) {
    range.setStart(startTextNode, startOffset);
    range.setEnd(endTextNode, endOffset);
  } else {
    range.setStart(endTextNode, endOffset);
    range.setEnd(startTextNode, startOffset);
  }
  const text = selectedTextWithLayout(range);
  if (!text) return null;
  return { text, type: classifySelection(text), rect: range.getBoundingClientRect(), range };
}

async function handleSelection(selected = selectedTextFromPage()) {
  if (!selected) return;
  const key = `${selected.type}:${selected.text}`;
  if (key === state.lastSelectionKey) return;
  state.lastSelectionKey = key;
  state.currentSelection = selected;
  if (selected.type === "word") playWordPronunciation(selected.text);
  markSelection(selected);
  els.explainPopover.classList.remove("hidden");
  await translateSelection(selected);
}

function bindRetranslateAction() {
  $("#retranslate-selection")?.addEventListener("mousedown", (event) => event.preventDefault());
  $("#retranslate-selection")?.addEventListener("click", retranslateEditedSelection);
}

async function retranslateEditedSelection() {
  const text = els.selectionQuote.value.trim();
  if (!text) {
    showToast("请先输入要查询的英文");
    return;
  }
  const baseSelection = state.currentSelection;
  if (!baseSelection) return;
  const selected = { ...baseSelection, text, type: classifySelection(text) };
  state.lastSelectionKey = `${selected.type}:${selected.text}`;
  state.currentSelection = selected;
  if (selected.type === "word") playWordPronunciation(selected.text);
  await translateSelection(selected);
}

async function translateSelection(selected) {
  els.popoverType.textContent = selected.type === "word" ? "单词精读" : "句子精读";
  els.popoverStatus.textContent = "正在理解…";
  els.selectionQuote.value = selected.text;
  els.popoverResult.innerHTML = `<div class="popover-skeleton"></div>`;
  els.popoverActions.innerHTML = `<button class="popover-action" id="retranslate-selection">重新翻译</button>`;
  bindRetranslateAction();
  positionPopover(selected.rect);
  try {
    const result = await requestJson("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: selected.text, type: selected.type }),
    });
    if (state.lastSelectionKey !== `${selected.type}:${selected.text}`) return;
    renderExplanation(result, selected);
    els.popoverStatus.textContent = result.mode === "remote" ? "联网 AI" : result.mode === "online" ? "在线翻译" : result.mode === "local-model" ? "本地模型" : result.mode === "local-dictionary" ? "本地词典" : "本地模式";
    positionPopover(selected.rect);
  } catch (error) {
    els.popoverStatus.textContent = "暂时无法理解";
    els.popoverResult.innerHTML = `<div class="result-note">${escapeHtml(error.message)}。原文没有受到影响。</div>`;
  }
}

function renderExplanation(result, selected) {
  if (selected.type === "word") {
    els.popoverResult.innerHTML = `
      <span class="result-label">词性</span>
      <span class="word-pos">${escapeHtml(result.pos || "语境词性")}</span>
      ${result.phonetic ? `<span class="result-label">音标</span><span class="word-pos phonetic">${escapeHtml(result.phonetic)}</span>` : ""}
      <span class="result-label">完整意思</span>
      <div class="result-meaning">${escapeHtml(result.meaning || "暂无释义")}</div>
      ${result.example ? `<div class="result-note">例句：${escapeHtml(result.example)}</div>` : ""}
    `;
    const saved = state.vocabulary.some((item) => item.word === selected.text.toLowerCase());
    els.popoverActions.innerHTML = `<button class="popover-action" id="retranslate-selection">重新翻译</button><button class="popover-action primary" id="save-word" ${saved ? "disabled" : ""}>${saved ? "✓ 已在生词本" : "⌁ 加入生词本"}</button>`;
    bindRetranslateAction();
    $("#save-word")?.addEventListener("mousedown", (event) => event.preventDefault());
    $("#save-word")?.addEventListener("click", () => saveWord(selected.text, result));
  } else {
    els.popoverResult.innerHTML = `
      <span class="result-label">完整中文意思</span>
      <div class="result-meaning">${escapeHtml(result.meaning || "暂无译文")}</div>
      ${result.note ? `<div class="result-note">${escapeHtml(result.note)}</div>` : ""}
    `;
    els.popoverActions.innerHTML = `<button class="popover-action" id="retranslate-selection">重新翻译</button><button class="popover-action" id="copy-translation">复制中文译文</button>`;
    bindRetranslateAction();
    $("#copy-translation")?.addEventListener("mousedown", (event) => event.preventDefault());
    $("#copy-translation")?.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(result.meaning || "");
      showToast("中文译文已复制");
    });
  }
}

async function saveWord(word, result) {
  const normalized = word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, "");
  if (!normalized) return;
  try {
    const payload = await requestJson("/api/vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ word: normalized, pos: result.pos, meaning: result.meaning, sourceTitle: state.currentPaper?.title }),
    });
    state.vocabulary = [payload.word, ...state.vocabulary.filter((item) => item.word !== normalized)];
    renderLibrary();
    renderVocabulary();
    renderExplanation(result, { type: "word", text: word });
    showToast(`“${normalized}” 已加入生词本`);
  } catch (error) {
    showToast(error.message);
  }
}

function renderVocabulary() {
  els.vocabCount.textContent = state.vocabulary.length;
  els.statWords.textContent = state.vocabulary.length;
  els.vocabTotal.textContent = state.vocabulary.length;
  if (!state.vocabulary.length) {
    state.vocabSelectedDates.clear();
    state.vocabSelectionInitialized = false;
    updateVocabSelectionUI();
    els.vocabList.innerHTML = `<div class="vocab-empty">还没有生词。阅读论文时选中一个单词，就可以把它留下来。</div>`;
    return;
  }
  const groups = groupedVocabulary();
  const availableDates = new Set(groups.map((group) => group.dateKey));
  if (!state.vocabSelectionInitialized) {
    state.vocabSelectedDates = new Set(availableDates);
    state.vocabSelectionInitialized = true;
  } else {
    state.vocabSelectedDates = new Set([...state.vocabSelectedDates].filter((dateKey) => availableDates.has(dateKey)));
  }
  els.vocabList.innerHTML = groups.map((group) => `
    <section class="vocab-day-group">
      <div class="vocab-day-header">
        <label class="vocab-day-select"><input class="vocab-date-check" type="checkbox" data-vocab-date="${group.dateKey}" ${state.vocabSelectedDates.has(group.dateKey) ? "checked" : ""}><span></span></label>
        <h2>${escapeHtml(group.label)}</h2><span class="vocab-day-count">${group.words.length} 个词</span>
      </div>
      <div class="vocab-day-words">${group.words.map((item) => `
        <div class="vocab-row"><div class="vocab-word">${escapeHtml(item.word)}</div><div class="vocab-pos">${escapeHtml(item.pos || "—")}</div><div class="vocab-meaning">${escapeHtml(item.meaning || "—")}</div><div class="vocab-date">${escapeHtml(item.sourceTitle || "论文阅读")}</div></div>
      `).join("")}</div>
    </section>
  `).join("");
  $$(".vocab-date-check").forEach((checkbox) => checkbox.addEventListener("change", (event) => {
    const dateKey = event.currentTarget.dataset.vocabDate;
    if (event.currentTarget.checked) state.vocabSelectedDates.add(dateKey);
    else state.vocabSelectedDates.delete(dateKey);
    updateVocabSelectionUI();
  }));
  updateVocabSelectionUI();
}

function updateVocabSelectionUI() {
  const selectedCount = state.vocabSelectedDates.size;
  const totalGroups = groupedVocabulary().length;
  if (els.vocabSelectionSummary) els.vocabSelectionSummary.textContent = `已选 ${selectedCount}/${totalGroups} 天`;
  if (els.vocabExport) els.vocabExport.disabled = selectedCount === 0;
}

async function exportVocabulary() {
  const groups = groupedVocabulary().filter((group) => state.vocabSelectedDates.has(group.dateKey));
  if (!groups.length) {
    showToast("请至少选择一天生词");
    return;
  }
  els.vocabExport.disabled = true;
  try {
    const response = await fetch("/api/vocab/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groups, words: groups.flatMap((group) => group.words) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "导出失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `墨读-生词本-${new Date().toISOString().slice(0, 10)}.docx`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${groups.reduce((total, group) => total + group.words.length, 0)} 个单词`);
  } catch (error) {
    showToast(error.message);
  } finally {
    updateVocabSelectionUI();
  }
}

function clearSearchHighlights() {
  $$(".search-highlight").forEach((marker) => marker.remove());
}

function highlightSearchMatch(match) {
  clearSearchHighlights();
  const textNode = match.span.firstChild;
  if (!textNode) return;
  const range = document.createRange();
  range.setStart(textNode, match.index);
  range.setEnd(textNode, match.index + match.length);
  const layer = match.span.closest(".textLayer");
  const layerRect = layer?.getBoundingClientRect();
  if (!layer || !layerRect) return;
  [...range.getClientRects()].forEach((rect) => {
    const marker = document.createElement("i");
    marker.className = "search-highlight";
    marker.style.left = `${rect.left - layerRect.left}px`;
    marker.style.top = `${rect.top - layerRect.top}px`;
    marker.style.width = `${rect.width}px`;
    marker.style.height = `${rect.height}px`;
    layer.appendChild(marker);
  });
}

function collectSearchMatches(query) {
  const matches = [];
  $$(".textLayer span").forEach((span) => {
    const text = span.textContent || "";
    const normalized = text.toLowerCase();
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(query, from);
      if (index < 0) break;
      matches.push({
        span,
        index,
        length: query.length,
        page: span.closest(".pdf-page")?.dataset.pageNumber || "—",
        text,
      });
      from = index + Math.max(1, query.length);
      if (matches.length >= 80) return;
    }
  });
  return matches;
}

function searchSnippet(match, query) {
  const start = Math.max(0, match.index - 42);
  const end = Math.min(match.text.length, match.index + match.length + 58);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < match.text.length ? "…" : "";
  const before = escapeHtml(match.text.slice(start, match.index));
  const hit = escapeHtml(match.text.slice(match.index, match.index + query.length));
  const after = escapeHtml(match.text.slice(match.index + query.length, end));
  return `${prefix}${before}<mark>${hit}</mark>${after}${suffix}`;
}

function searchMeaningHtml(query, result, error = "") {
  if (error) return `<div class="search-meaning"><div class="search-empty">${escapeHtml(error)}</div></div>`;
  if (!result) return `<div class="search-meaning"><div class="search-loading">正在查询“${escapeHtml(query)}”…</div></div>`;
  return `<div class="search-meaning">${result.pos ? `<span class="word-pos">${escapeHtml(result.pos)}</span>` : ""}<strong>${escapeHtml(result.meaning || "暂无释义")}</strong></div>`;
}

function renderSearchResults(query, matches, result, error = "") {
  const visibleMatches = matches.slice(0, 24);
  const list = visibleMatches.length
    ? `<span class="search-section-label">文章中出现 ${matches.length >= 80 ? "80+" : matches.length} 处 · 点击定位</span><div class="search-results-list">${visibleMatches.map((match, index) => `<button class="search-result" type="button" data-search-index="${index}"><span class="search-result-page">第 ${escapeHtml(match.page)} 页</span><span class="search-result-snippet">${searchSnippet(match, query)}</span></button>`).join("")}</div>`
    : `<span class="search-section-label">文章中出现</span><div class="search-empty">暂时没有找到“${escapeHtml(query)}”。</div>`;
  els.searchResults.innerHTML = `${searchMeaningHtml(query, result, error)}${list}`;
  els.searchResults.classList.remove("hidden");
  $$(".search-result").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const match = state.searchMatches[Number(button.dataset.searchIndex)];
      if (!match) return;
      const page = match.span.closest(".pdf-page");
      if (page) els.pdfScroll.scrollTo({ top: Math.max(0, page.offsetTop - 100), behavior: "smooth" });
      window.setTimeout(() => highlightSearchMatch(match), 160);
    });
  });
}

async function runPaperSearch(value = els.searchInput.value) {
  const query = value.trim().toLowerCase();
  state.searchQuery = query;
  state.searchRequestId += 1;
  const requestId = state.searchRequestId;
  clearSearchHighlights();
  if (!query) {
    state.searchMatches = [];
    els.searchResults.classList.add("hidden");
    return;
  }
  state.searchMatches = collectSearchMatches(query);
  renderSearchResults(query, state.searchMatches, null);
  try {
    const result = await requestJson("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value.trim(), type: classifySelection(value.trim()) }),
    });
    if (requestId !== state.searchRequestId || state.searchQuery !== query) return;
    renderSearchResults(query, state.searchMatches, result);
  } catch (error) {
    if (requestId !== state.searchRequestId || state.searchQuery !== query) return;
    renderSearchResults(query, state.searchMatches, null, error.message || "查询失败");
  }
}

function resetPaperSearch() {
  state.searchRequestId += 1;
  state.searchMatches = [];
  state.searchQuery = "";
  clearSearchHighlights();
  if (els.searchInput) els.searchInput.value = "";
  els.searchResults?.classList.add("hidden");
}

function closePopover() {
  els.explainPopover.classList.add("hidden");
  clearTimeout(handleSelection.timer);
  stopPronunciation();
  window.getSelection()?.removeAllRanges();
  clearSelectionMarkers();
  selectionGesture.start = null;
  selectionGesture.end = null;
  selectionGesture.active = false;
  state.currentSelection = null;
  state.lastSelectionKey = "";
}

document.addEventListener("selectionchange", () => {
  if (selectionGesture.active || selectionGesture.start) return;
  clearTimeout(handleSelection.timer);
  handleSelection.timer = setTimeout(handleSelection, 120);
});

document.addEventListener("mousedown", (event) => {
  if (event.target.closest?.(".explain-popover") || event.target.closest?.(".paper-search")) return;
  if (event.target.closest?.(".textLayer")) {
    closePopover();
    selectionGesture.active = true;
    selectionGesture.start = { x: event.clientX, y: event.clientY, target: event.target };
  }
});

document.addEventListener("mouseup", (event) => {
  if (event.target.closest?.(".explain-popover") || event.target.closest?.(".paper-search")) return;
  if (!selectionGesture.start) {
    if (!els.explainPopover.contains(event.target)) closePopover();
    return;
  }
  selectionGesture.end = { x: event.clientX, y: event.clientY, target: event.target };
  selectionGesture.active = false;
  // 在 mouseup 这一刻启动单词发音，保留用户点击带来的播放权限；句子不触发。
  const gestureDistance = Math.hypot(event.clientX - selectionGesture.start.x, event.clientY - selectionGesture.start.y);
  if (gestureDistance < 14) {
    const span = selectionGesture.start.target?.closest?.(".textLayer span");
    const wordSelection = span && wordRangeAtPoint(span, selectionGesture.start.x, selectionGesture.start.y);
    if (wordSelection?.text) playWordPronunciation(wordSelection.text);
  }
  setTimeout(() => {
    // 拖动选区时，以鼠标起止落点重建 Range，避免浏览器原生选区多吃相邻文字。
    const clickSpan = selectionGesture.start?.target?.closest?.(".textLayer span");
    const clickWord = gestureDistance < 14 && clickSpan
      ? wordRangeAtPoint(clickSpan, selectionGesture.start.x, selectionGesture.start.y)
      : null;
    const manual = gestureDistance < 14 ? null : manualSelectionFromGesture();
    const selected = clickWord?.text
      ? { text: clickWord.text, type: "word", rect: clickWord.range.getBoundingClientRect(), range: clickWord.range }
      : manual || selectedTextFromPage();
    if (selected) {
      if (selected.range) {
        const nativeSelection = window.getSelection();
        nativeSelection?.removeAllRanges();
        nativeSelection?.addRange(selected.range);
      }
      selectionGesture.start = null;
      selectionGesture.end = null;
      handleSelection(selected);
    } else {
      closePopover();
    }
  }, 80);
});

window.addEventListener("resize", () => {
  if (!els.explainPopover.classList.contains("hidden") && state.currentSelection) positionPopover(state.currentSelection.rect);
});

$$('.nav-item').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("#open-current").addEventListener("click", () => state.papers[0] && openReader(state.papers[0].id));
$("#refresh-library").addEventListener("click", async () => {
  const button = $("#refresh-library");
  button.disabled = true;
  try { await loadLibrary(); showToast("论文库已刷新"); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
});
$("#back-to-library").addEventListener("click", () => { closePopover(); switchView("library"); });
$("#close-popover").addEventListener("click", closePopover);
$("#dismiss-tip").addEventListener("click", (event) => event.currentTarget.closest(".reading-tip").remove());
$("#reader-vocab").addEventListener("click", () => switchView("vocabulary"));
$("#vocab-select-all").addEventListener("click", () => {
  state.vocabSelectedDates = new Set(groupedVocabulary().map((group) => group.dateKey));
  $$(".vocab-date-check").forEach((checkbox) => { checkbox.checked = true; });
  updateVocabSelectionUI();
});
$("#vocab-select-none").addEventListener("click", () => {
  state.vocabSelectedDates.clear();
  $$(".vocab-date-check").forEach((checkbox) => { checkbox.checked = false; });
  updateVocabSelectionUI();
});
$("#vocab-export").addEventListener("click", exportVocabulary);
$("#search-button").addEventListener("click", () => showToast("搜索功能会在论文数量增加后开放"));
$("#settings-button").addEventListener("click", showModeGate);
els.modeChip?.addEventListener("click", showModeGate);
$("#reader-mode-switch")?.addEventListener("click", showModeGate);
$$("[data-mode-choice]").forEach((button) => button.addEventListener("click", () => chooseMode(button.dataset.modeChoice)));
$("#reader-settings").addEventListener("click", () => showToast("阅读字号设置即将加入"));

let paperSearchTimer;
els.searchInput.addEventListener("mousedown", (event) => event.stopPropagation());
els.searchInput.addEventListener("mouseup", (event) => event.stopPropagation());
els.searchInput.addEventListener("click", (event) => event.stopPropagation());
els.searchSubmit.addEventListener("mousedown", (event) => event.stopPropagation());
els.searchSubmit.addEventListener("mouseup", (event) => event.stopPropagation());
els.searchSubmit.addEventListener("click", (event) => event.stopPropagation());
els.searchInput.addEventListener("input", () => {
  clearTimeout(paperSearchTimer);
  const value = els.searchInput.value.trim();
  if (!value) {
    resetPaperSearch();
    return;
  }
  paperSearchTimer = setTimeout(() => runPaperSearch(value), 420);
});
els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    clearTimeout(paperSearchTimer);
    runPaperSearch(els.searchInput.value);
  }
  if (event.key === "Escape") {
    els.searchResults.classList.add("hidden");
    els.searchInput.blur();
  }
});
els.searchSubmit.addEventListener("click", () => {
  clearTimeout(paperSearchTimer);
  runPaperSearch(els.searchInput.value);
});
document.addEventListener("mousedown", (event) => {
  if (!event.target.closest?.(".paper-search")) els.searchResults.classList.add("hidden");
});

updateModeUI();
els.modeGate?.classList.add("hidden");
loadLibrary().catch((error) => {
  els.paperGrid.innerHTML = `<div class="empty-state">无法连接论文库：${escapeHtml(error.message)}</div>`;
});
