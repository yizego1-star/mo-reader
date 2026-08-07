import * as pdfjsLib from "/vendor/pdfjs/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  mode: localStorage.getItem("mo-reader-mode") || "online",
  papers: [],
  vocabulary: [],
  annotations: [],
  annotationTool: "none",
  annotationStyle: "marker",
  annotationColor: "green",
  readerZoom: Number(localStorage.getItem("mo-reader-zoom") || 1),
  renderToken: 0,
  libraryLayout: localStorage.getItem("mo-reader-library-layout") || "grid",
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
const CLICK_DRAG_THRESHOLD = 6;

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
  paperImportCard: $("#paper-import-card"),
  paperChooseFiles: $("#paper-choose-files"),
  paperChooseFolder: $("#paper-choose-folder"),
  paperFileInput: $("#paper-file-input"),
  paperFolderInput: $("#paper-folder-input"),
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
  annotationToolbar: $("#annotation-toolbar"),
  readerZoomLabel: $("#reader-zoom-label"),
  toast: $("#toast"),
};

state.readerZoom = Math.min(1.8, Math.max(0.75, Number.isFinite(state.readerZoom) ? state.readerZoom : 1));
if (!["grid", "list"].includes(state.libraryLayout)) state.libraryLayout = "grid";

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

async function importPapers(fileList) {
  const files = [...fileList].filter((file) => /\.pdf$/i.test(file.name));
  if (!files.length) {
    showToast("请选择 PDF 文件");
    return;
  }

  const importCard = els.paperImportCard;
  importCard?.classList.add("uploading");
  const imported = [];
  const skipped = [];
  const failed = [];
  try {
    for (const file of files) {
      try {
        const response = await fetch("/api/papers/import", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/pdf",
            "x-paper-file-name": encodeURIComponent(file.name),
          },
          body: file,
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 409) skipped.push(file.name);
        else if (!response.ok) throw new Error(payload.error || "导入失败");
        else imported.push(payload.paper?.fileName || file.name);
      } catch (error) {
        failed.push(`${file.name}：${error.message}`);
      }
    }
    await loadLibrary();
    const summary = [`成功导入 ${imported.length} 篇`];
    if (skipped.length) summary.push(`已存在 ${skipped.length} 篇`);
    if (failed.length) summary.push(`失败 ${failed.length} 篇`);
    showToast(summary.join("，"));
    if (failed.length) console.warn("论文导入失败：", failed);
  } finally {
    importCard?.classList.remove("uploading");
    if (els.paperFileInput) els.paperFileInput.value = "";
    if (els.paperFolderInput) els.paperFolderInput.value = "";
  }
}

function renderLibrary() {
  els.paperCount.textContent = state.papers.length;
  els.statPapers.textContent = state.papers.length;
  els.vocabCount.textContent = state.vocabulary.length;
  els.statWords.textContent = state.vocabulary.length;
  updateLibraryLayoutUI();
  if (!state.papers.length) {
    els.paperGrid.innerHTML = `<div class="empty-state">暂时还没有 PDF。把论文放进当前文件夹，然后点击“刷新论文库”。</div>`;
    return;
  }
  els.paperGrid.classList.toggle("list-view", state.libraryLayout === "list");
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

function updateLibraryLayoutUI() {
  els.paperGrid?.classList.toggle("list-view", state.libraryLayout === "list");
  $$("[data-library-layout]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.libraryLayout === state.libraryLayout);
  });
}

function setLibraryLayout(layout) {
  if (!["grid", "list"].includes(layout)) return;
  state.libraryLayout = layout;
  localStorage.setItem("mo-reader-library-layout", layout);
  updateLibraryLayoutUI();
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
  syncReaderViewport();
}

// 双指缩放会改变实际可见的 visualViewport；固定工具必须跟随它，
// 才不会被放大的页面裁到屏幕外。
function syncReaderViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty("--reader-viewport-width", `${viewport?.width || window.innerWidth}px`);
  root.setProperty("--reader-viewport-height", `${viewport?.height || window.innerHeight}px`);
  root.setProperty("--reader-viewport-left", `${viewport?.offsetLeft || 0}px`);
  root.setProperty("--reader-viewport-top", `${viewport?.offsetTop || 0}px`);
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
  state.annotations = [];
  els.pdfScroll.innerHTML = "";
  els.readerLoading.innerHTML = `<div class="loading-spinner"></div><span>正在打开论文…</span>`;
  els.readerLoading.classList.remove("hidden");
  closePopover();
  try {
    state.annotations = (await requestJson(`/api/annotations?paper=${encodeURIComponent(paper.fileName)}`)).annotations || [];
    state.currentPdf = await pdfjsLib.getDocument(`/pdf/${encodeURIComponent(paper.fileName)}`).promise;
    await renderCurrentPdf();
    els.readerLoading.classList.add("hidden");
  } catch (error) {
    els.readerLoading.innerHTML = `<div style="font-size:28px;margin-bottom:6px">⌁</div><span>这篇 PDF 暂时无法打开：${escapeHtml(error.message)}</span>`;
  }
}

async function renderCurrentPdf({ preserveScroll = false } = {}) {
  if (!state.currentPdf) return;
  const token = state.renderToken + 1;
  state.renderToken = token;
  const maxScroll = Math.max(1, els.pdfScroll.scrollHeight - els.pdfScroll.clientHeight);
  const scrollRatio = preserveScroll ? els.pdfScroll.scrollTop / maxScroll : 0;
  els.pdfScroll.innerHTML = "";
  for (let pageNumber = 1; pageNumber <= state.currentPdf.numPages; pageNumber += 1) {
    if (token !== state.renderToken) return;
    await renderPdfPage(pageNumber, token);
  }
  if (preserveScroll && token === state.renderToken) {
    const nextMaxScroll = Math.max(0, els.pdfScroll.scrollHeight - els.pdfScroll.clientHeight);
    els.pdfScroll.scrollTop = nextMaxScroll * scrollRatio;
  }
}

async function renderPdfPage(pageNumber, token = state.renderToken) {
  if (token !== state.renderToken) return;
  const page = await state.currentPdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(300, els.pdfScroll.clientWidth - 28);
  const fitWidth = Math.min(760, availableWidth);
  const targetWidth = clamp(fitWidth * state.readerZoom, 320, 1600);
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const wrapper = document.createElement("div");
  wrapper.className = "pdf-page";
  wrapper.dataset.pageNumber = pageNumber;
  wrapper.style.width = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;
  wrapper.style.setProperty("--scale-factor", viewport.scale);
  const canvas = document.createElement("canvas");
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  wrapper.appendChild(canvas);
  const annotationLayer = document.createElement("div");
  annotationLayer.className = "annotation-layer";
  wrapper.appendChild(annotationLayer);
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.dataset.pageNumber = pageNumber;
  wrapper.appendChild(textLayer);
  els.pdfScroll.appendChild(wrapper);

  const context = canvas.getContext("2d", { alpha: false });
  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
  if (token !== state.renderToken) {
    wrapper.remove();
    return;
  }
  const textContent = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  await buildSelectableTextLayer(textLayer, textContent, viewport);
  if (token !== state.renderToken) {
    wrapper.remove();
    return;
  }
  renderAnnotationsForPage(pageNumber);
}

async function buildSelectableTextLayer(textLayer, textContent, viewport) {
  const textLayerTask = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayer,
    viewport,
  });
  await textLayerTask.render();
  const endOfContent = document.createElement("div");
  endOfContent.className = "endOfContent";
  textLayer.appendChild(endOfContent);
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

function trimRangeWhitespace(range) {
  const layer = nodeInTextLayer(range?.startContainer);
  const endLayer = nodeInTextLayer(range?.endContainer);
  if (!layer || layer !== endLayer) return range;

  let firstBoundary = null;
  let lastBoundary = null;
  const textNodes = [...layer.querySelectorAll("span")]
    .map((span) => span.firstChild)
    .filter((node) => node?.nodeType === Node.TEXT_NODE && range.intersectsNode(node));

  textNodes.forEach((node) => {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    const pieceRange = range.cloneRange();
    if (pieceRange.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
      pieceRange.setStart(node, 0);
    }
    if (pieceRange.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
      pieceRange.setEnd(node, node.textContent.length);
    }
    const text = pieceRange.toString();
    if (!text) return;
    const leading = text.search(/\S/);
    const trailing = text.search(/\s*$/);
    if (leading < 0 || trailing <= leading) return;
    const startOffset = pieceRange.startContainer === node ? pieceRange.startOffset : 0;
    const endOffset = pieceRange.endContainer === node ? pieceRange.endOffset : node.textContent.length;
    if (!firstBoundary) firstBoundary = { node, offset: startOffset + leading };
    lastBoundary = { node, offset: startOffset + Math.min(trailing, endOffset - startOffset) };
  });

  if (firstBoundary && lastBoundary) {
    range.setStart(firstBoundary.node, firstBoundary.offset);
    range.setEnd(lastBoundary.node, lastBoundary.offset);
  }
  return range;
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
  const range = selection.getRangeAt(0).cloneRange();
  if (!nodeInTextLayer(range.startContainer) || !nodeInTextLayer(range.endContainer)) return null;
  trimRangeWhitespace(range);
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

function currentAnnotationMode() {
  return state.annotationTool === "pen" || state.annotationTool === "eraser";
}

function pageForRect(rect) {
  return $$(".pdf-page").find((page) => {
    const pageRect = page.getBoundingClientRect();
    return rect.right > pageRect.left && rect.left < pageRect.right && rect.bottom > pageRect.top && rect.top < pageRect.bottom;
  });
}

function mergeSelectionClientRects(rects) {
  const merged = [];
  rects
    .filter((rect) => rect.width > 1 && rect.height > 1)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .forEach((rect) => {
      const current = merged[merged.length - 1];
      const sameLine = current && current.page === rect.page && Math.abs(current.top - rect.top) < Math.max(5, rect.height * 0.55);
      const close = current && rect.left - current.right < Math.max(12, rect.height * 1.4);
      if (sameLine && close) {
        current.right = Math.max(current.right, rect.right);
        current.bottom = Math.max(current.bottom, rect.bottom);
        return;
      }
      merged.push({ ...rect });
    });
  return merged;
}

function annotationRectsForRange(range) {
  if (!range) return [];
  const rawRects = [...range.getClientRects()].map((rect) => {
    const page = pageForRect(rect);
    if (!page) return null;
    return { rect, page, pageNumber: Number(page.dataset.pageNumber || 0) };
  }).filter(Boolean);
  const merged = mergeSelectionClientRects(rawRects.map(({ rect, page, pageNumber }) => ({
    page,
    pageNumber,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  })));
  return merged.map((rect) => {
    const pageRect = rect.page.getBoundingClientRect();
    const left = Math.max(rect.left, pageRect.left);
    const top = Math.max(rect.top, pageRect.top);
    const right = Math.min(rect.right, pageRect.right);
    const bottom = Math.min(rect.bottom, pageRect.bottom);
    return {
      page: rect.pageNumber,
      left: (left - pageRect.left) / pageRect.width,
      top: (top - pageRect.top) / pageRect.height,
      width: Math.max(0, right - left) / pageRect.width,
      height: Math.max(0, bottom - top) / pageRect.height,
    };
  }).filter((rect) => rect.page && rect.width > 0 && rect.height > 0);
}

function renderAnnotationsForPage(pageNumber) {
  const page = $(`.pdf-page[data-page-number="${pageNumber}"]`);
  const layer = page?.querySelector(".annotation-layer");
  if (!layer) return;
  layer.innerHTML = "";
  state.annotations.forEach((annotation) => {
    annotation.rects?.filter((rect) => Number(rect.page) === Number(pageNumber)).forEach((rect) => {
      const mark = document.createElement("i");
      mark.className = "annotation-mark";
      mark.dataset.annotationId = annotation.id;
      mark.dataset.annotationStyle = annotation.style || "marker";
      mark.dataset.annotationColor = annotation.color || "green";
      mark.style.left = `${rect.left * 100}%`;
      mark.style.top = `${rect.top * 100}%`;
      mark.style.width = `${rect.width * 100}%`;
      mark.style.height = `${rect.height * 100}%`;
      layer.appendChild(mark);
    });
  });
}

function renderAllAnnotations() {
  $$(".pdf-page").forEach((page) => renderAnnotationsForPage(page.dataset.pageNumber));
}

async function addAnnotationFromSelection(selected) {
  const rects = annotationRectsForRange(selected.range);
  if (!rects.length || !state.currentPaper) {
    showToast("没有识别到可批注的文本");
    return;
  }
  const payload = await requestJson("/api/annotations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paperId: state.currentPaper.fileName,
      color: state.annotationColor,
      style: state.annotationStyle,
      text: selected.text,
      rects,
    }),
  });
  state.annotations = payload.annotations || [payload.annotation, ...state.annotations].filter(Boolean);
  renderAllAnnotations();
  showToast("已批注");
}

function rectsOverlap(first, second) {
  if (Number(first.page) !== Number(second.page)) return false;
  return first.left < second.left + second.width
    && first.left + first.width > second.left
    && first.top < second.top + second.height
    && first.top + first.height > second.top;
}

function trimAnnotationRect(source, eraser) {
  if (!rectsOverlap(source, eraser)) return [source];
  const sourceRight = source.left + source.width;
  const sourceBottom = source.top + source.height;
  const eraseRight = eraser.left + eraser.width;
  const eraseBottom = eraser.top + eraser.height;
  const cutLeft = Math.max(source.left, eraser.left);
  const cutTop = Math.max(source.top, eraser.top);
  const cutRight = Math.min(sourceRight, eraseRight);
  const cutBottom = Math.min(sourceBottom, eraseBottom);
  const fragments = [
    { ...source, height: cutTop - source.top },
    { ...source, top: cutBottom, height: sourceBottom - cutBottom },
    { ...source, top: cutTop, width: cutLeft - source.left, height: cutBottom - cutTop },
    { ...source, left: cutRight, top: cutTop, width: sourceRight - cutRight, height: cutBottom - cutTop },
  ];
  // 过滤掉不足一个像素的碎片，避免留下难以看见、也难以再次擦除的残点。
  return fragments.filter((rect) => rect.width > 0.001 && rect.height > 0.001);
}

async function eraseAnnotationsFromSelection(selected) {
  const rects = annotationRectsForRange(selected.range);
  if (!rects.length || !state.currentPaper) {
    showToast("先选中要擦除的批注");
    return;
  }
  const updates = state.annotations.map((annotation) => {
    let changed = false;
    const remainingRects = (annotation.rects || []).flatMap((savedRect) => rects.reduce((fragments, eraserRect) => {
      if (fragments.some((fragment) => rectsOverlap(fragment, eraserRect))) changed = true;
      return fragments.flatMap((fragment) => trimAnnotationRect(fragment, eraserRect));
    }, [savedRect]));
    return changed ? { id: annotation.id, rects: remainingRects } : null;
  }).filter(Boolean);
  if (!updates.length) {
    showToast("这段没有批注");
    return;
  }
  const payload = await requestJson("/api/annotations/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paperId: state.currentPaper.fileName, updates }),
  });
  state.annotations = payload.annotations || state.annotations;
  renderAllAnnotations();
  showToast(`已精细擦除 ${updates.length} 处批注`);
}

async function handleAnnotationSelection(selected) {
  if (!selected) return;
  clearSelectionMarkers();
  clearTimeout(handleSelection.timer);
  state.currentSelection = null;
  state.lastSelectionKey = "";
  try {
    if (state.annotationTool === "eraser") await eraseAnnotationsFromSelection(selected);
    else await addAnnotationFromSelection(selected);
  } catch (error) {
    showToast(error.message || "批注失败");
  } finally {
    window.getSelection()?.removeAllRanges();
  }
}

function wordFromSpanAtPoint(span, x) {
  return wordRangeAtPoint(span, x)?.text || "";
}

function spanAtPoint(x, y, fallbackTarget) {
  const pointTarget = document.elementFromPoint?.(x, y);
  const direct = pointTarget?.closest?.(".textLayer span") || fallbackTarget?.closest?.(".textLayer span");
  if (direct) return direct;
  const layer = pointTarget?.closest?.(".textLayer") || fallbackTarget?.closest?.(".textLayer");
  if (!layer) return null;
  return [...layer.querySelectorAll("span")]
    .map((span) => {
      const rect = span.getBoundingClientRect();
      const horizontalDistance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const verticalDistance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      return { span, distance: horizontalDistance + verticalDistance * 4 };
    })
    .sort((first, second) => first.distance - second.distance)[0]?.span || null;
}

function wordRangeAtPoint(span, x, y) {
  const textNode = span?.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !span?.contains(textNode)) return null;
  const text = textNode.textContent || "";
  const words = [...text.matchAll(/[A-Za-z][A-Za-z'’\-]*/g)];
  if (!words.length) return null;
  const candidates = words.map((match) => {
    const range = document.createRange();
    range.setStart(textNode, match.index);
    range.setEnd(textNode, match.index + match[0].length);
    const rect = range.getBoundingClientRect();
    const distance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    return { text: match[0], range, rect, distance };
  });
  candidates.sort((first, second) => first.distance - second.distance || first.rect.left - second.rect.left);
  const nearest = candidates[0];
  return nearest?.text ? { text: nearest.text, range: nearest.range } : null;
}

function textOffsetAtPoint(span, x, bias = "nearest") {
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
    if (bias === "start" && x <= rect.left + 1) return offset;
    if (bias === "end" && x >= rect.right - 1 && x <= rect.right + 1) return offset + 1;
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
  const startSpan = spanAtPoint(start.x, start.y, start.target);
  const endSpan = spanAtPoint(end.x, end.y, end.target);
  if (!startSpan || !endSpan || startSpan.closest(".textLayer") !== endSpan.closest(".textLayer")) return null;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < CLICK_DRAG_THRESHOLD) {
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
  const rawStartOffset = textOffsetAtPoint(startSpan, start.x);
  const rawEndOffset = textOffsetAtPoint(endSpan, end.x);
  const forward = startIndex < endIndex || (startIndex === endIndex && rawStartOffset <= rawEndOffset);
  const rangeStartSpan = forward ? startSpan : endSpan;
  const rangeStartPoint = forward ? start : end;
  const rangeEndSpan = forward ? endSpan : startSpan;
  const rangeEndPoint = forward ? end : start;
  const rangeStartOffset = textOffsetAtPoint(rangeStartSpan, rangeStartPoint.x, "start");
  const rangeEndOffset = textOffsetAtPoint(rangeEndSpan, rangeEndPoint.x, "end");
  const rangeStartNode = rangeStartSpan.firstChild;
  const rangeEndNode = rangeEndSpan.firstChild;
  const range = document.createRange();
  range.setStart(rangeStartNode, rangeStartOffset);
  range.setEnd(rangeEndNode, rangeEndOffset);
  trimRangeWhitespace(range);
  const text = selectedTextWithLayout(range);
  if (!text) return null;
  return { text, type: classifySelection(text), rect: range.getBoundingClientRect(), range };
}

async function handleSelection(selected = selectedTextFromPage()) {
  if (currentAnnotationMode()) {
    await handleAnnotationSelection(selected);
    return;
  }
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

function locateSearchMatch(match) {
  const layer = match.span.closest(".textLayer");
  const page = match.span.closest(".pdf-page");
  if (!layer || !page) return false;
  const targetRect = match.span.getBoundingClientRect();
  const scrollRect = els.pdfScroll.getBoundingClientRect();
  // 用目标文字相对阅读滚动区的实时坐标定位，不能使用 page.offsetTop：
  // 它相对的是外层定位容器，缩放或固定顶栏时会产生偏差。
  const top = Math.max(0, els.pdfScroll.scrollTop + targetRect.top - scrollRect.top - 118);
  els.pdfScroll.scrollTo({ top, behavior: "smooth" });
  highlightSearchMatch(match);
  page.classList.remove("search-target-page");
  void page.offsetWidth;
  page.classList.add("search-target-page");
  window.setTimeout(() => page.classList.remove("search-target-page"), 1250);
  return true;
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
      if (!locateSearchMatch(match)) showToast("该位置暂时未加载完成，请稍后再试");
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

function updateAnnotationUI() {
  document.body.classList.toggle("annotation-mode", state.annotationTool === "pen");
  document.body.classList.toggle("eraser-mode", state.annotationTool === "eraser");
  $$("[data-annotation-style]").forEach((button) => {
    button.classList.toggle("selected", state.annotationTool === "pen" && button.dataset.annotationStyle === state.annotationStyle);
  });
  $$("[data-annotation-color]").forEach((button) => {
    button.classList.toggle("selected", state.annotationTool === "pen" && button.dataset.annotationColor === state.annotationColor);
  });
  $("[data-annotation-eraser]")?.classList.toggle("selected", state.annotationTool === "eraser");
  $("[data-annotation-off]")?.classList.toggle("selected", state.annotationTool === "none");
}

function activateAnnotationPen(options = {}) {
  state.annotationTool = "pen";
  if (options.style) state.annotationStyle = options.style;
  if (options.color) state.annotationColor = options.color;
  closePopover();
  updateAnnotationUI();
}

function activateAnnotationEraser() {
  state.annotationTool = "eraser";
  closePopover();
  updateAnnotationUI();
}

function deactivateAnnotationTools() {
  state.annotationTool = "none";
  updateAnnotationUI();
}

function updateReaderZoomUI() {
  if (els.readerZoomLabel) els.readerZoomLabel.textContent = `${Math.round(state.readerZoom * 100)}`;
  $$("[data-reader-zoom]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.readerZoom === "reset" && Math.abs(state.readerZoom - 1) < 0.01);
  });
}

async function setReaderZoom(nextZoom) {
  const zoom = Math.round(clamp(nextZoom, 0.75, 1.8) * 100) / 100;
  if (Math.abs(zoom - state.readerZoom) < 0.01) return;
  state.readerZoom = zoom;
  localStorage.setItem("mo-reader-zoom", String(zoom));
  updateReaderZoomUI();
  closePopover();
  if (!state.currentPdf) return;
  els.readerLoading.innerHTML = `<div class="loading-spinner"></div><span>正在调整论文大小…</span>`;
  els.readerLoading.classList.remove("hidden");
  await renderCurrentPdf({ preserveScroll: true });
  els.readerLoading.classList.add("hidden");
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
  if (currentAnnotationMode()) return;
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
  const isClick = gestureDistance < CLICK_DRAG_THRESHOLD;
  if (isClick && !currentAnnotationMode()) {
    const span = spanAtPoint(selectionGesture.start.x, selectionGesture.start.y, selectionGesture.start.target);
    const wordSelection = span && wordRangeAtPoint(span, selectionGesture.start.x, selectionGesture.start.y);
    if (wordSelection?.text) playWordPronunciation(wordSelection.text);
  }
  setTimeout(() => {
    // 拖动选区时，以鼠标起止落点重建 Range，避免浏览器原生选区多吃相邻文字。
    const clickSpan = selectionGesture.start && spanAtPoint(selectionGesture.start.x, selectionGesture.start.y, selectionGesture.start.target);
    const clickWord = isClick && clickSpan
      ? wordRangeAtPoint(clickSpan, selectionGesture.start.x, selectionGesture.start.y)
      : null;
    const manual = isClick ? null : manualSelectionFromGesture();
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
      if (currentAnnotationMode()) handleAnnotationSelection(selected);
      else handleSelection(selected);
    } else {
      closePopover();
    }
  }, 80);
});

window.addEventListener("resize", () => {
  syncReaderViewport();
  if (!els.explainPopover.classList.contains("hidden") && state.currentSelection) positionPopover(state.currentSelection.rect);
});
window.visualViewport?.addEventListener("resize", syncReaderViewport);
window.visualViewport?.addEventListener("scroll", syncReaderViewport);

$$('.nav-item').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("#open-current").addEventListener("click", () => state.papers[0] && openReader(state.papers[0].id));
$("#refresh-library").addEventListener("click", async () => {
  const button = $("#refresh-library");
  button.disabled = true;
  try { await loadLibrary(); showToast("论文库已刷新"); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
});
els.paperImportCard?.addEventListener("click", () => els.paperFileInput?.click());
els.paperImportCard?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.paperFileInput?.click();
  }
});
els.paperChooseFiles?.addEventListener("click", (event) => {
  event.stopPropagation();
  els.paperFileInput?.click();
});
els.paperChooseFolder?.addEventListener("click", (event) => {
  event.stopPropagation();
  els.paperFolderInput?.click();
});
els.paperFileInput?.addEventListener("change", (event) => importPapers(event.target.files));
els.paperFolderInput?.addEventListener("change", (event) => importPapers(event.target.files));
els.paperImportCard?.addEventListener("dragenter", (event) => {
  event.preventDefault();
  els.paperImportCard.classList.add("drag-over");
});
els.paperImportCard?.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  els.paperImportCard.classList.add("drag-over");
});
els.paperImportCard?.addEventListener("dragleave", (event) => {
  if (!els.paperImportCard.contains(event.relatedTarget)) els.paperImportCard.classList.remove("drag-over");
});
els.paperImportCard?.addEventListener("drop", (event) => {
  event.preventDefault();
  els.paperImportCard.classList.remove("drag-over");
  importPapers(event.dataTransfer.files);
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
$$("[data-library-layout]").forEach((button) => button.addEventListener("click", () => setLibraryLayout(button.dataset.libraryLayout)));
$$("[data-reader-zoom]").forEach((button) => button.addEventListener("click", async (event) => {
  event.stopPropagation();
  const action = button.dataset.readerZoom;
  try {
    if (action === "in") await setReaderZoom(state.readerZoom + 0.15);
    if (action === "out") await setReaderZoom(state.readerZoom - 0.15);
    if (action === "reset") await setReaderZoom(1);
  } catch (error) {
    showToast(error.message || "缩放失败");
  }
}));
$$("[data-annotation-style]").forEach((button) => button.addEventListener("click", (event) => {
  event.stopPropagation();
  activateAnnotationPen({ style: button.dataset.annotationStyle });
}));
$$("[data-annotation-color]").forEach((button) => button.addEventListener("click", (event) => {
  event.stopPropagation();
  activateAnnotationPen({ color: button.dataset.annotationColor });
}));
$("[data-annotation-eraser]")?.addEventListener("click", (event) => {
  event.stopPropagation();
  activateAnnotationEraser();
});
$("[data-annotation-off]")?.addEventListener("click", (event) => {
  event.stopPropagation();
  deactivateAnnotationTools();
});

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
updateAnnotationUI();
updateReaderZoomUI();
updateLibraryLayoutUI();
syncReaderViewport();
els.modeGate?.classList.add("hidden");
loadLibrary().catch((error) => {
  els.paperGrid.innerHTML = `<div class="empty-state">无法连接论文库：${escapeHtml(error.message)}</div>`;
});
