import {
  initVoiceSelector,
  speakText,
  cancelSpeech,
  appendInteractiveWords
} from './tts.js';
import {
  loadSiteConfig,
  loadJsonFromSource,
  parseManualJsonFiles,
  ensureTrailingSlash
} from './json-loader.js';
import { renderLinkingNotes } from './linking-notes.js';

const CONFIG_PATH = './config.json';
const DEFAULT_FOLDER_NAME = 'sentences_json';
const DEFAULT_BASE_URL = `https://raw.githubusercontent.com/nicklian1927/english-trainer/resource/${DEFAULT_FOLDER_NAME}/`;
const SCAN_TIMEOUT_MS = 1500;
const FILE_TIMEOUT_MS = 4000;

const decks = new Map();
let activeDeckKey = '';
let sentences = [];
let currentIndex = 0;
let blindCount = 0;
let shadowCount = 0;
let isRevealed = false;
let isAllSentencesOpen = false;
let activeSourceInfo = {
  baseUrl: DEFAULT_BASE_URL,
  folderName: DEFAULT_FOLDER_NAME,
  manifestFile: 'manifest.json',
  files: []
};

const $ = id => document.getElementById(id);

function setPracticeEnabled(enabled) {
  ['play10', 'play075', 'play05', 'revealBtn', 'prevBtn', 'nextBtn', 'toggleAllSentencesBtn'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
}

function showError(message) {
  const box = $('errorBox');
  box.innerHTML = message;
  box.style.display = 'block';
}

function clearError() {
  const box = $('errorBox');
  box.style.display = 'none';
  box.innerHTML = '';
}

async function resolveSentenceSourceConfig() {
  try {
    const cfg = await loadSiteConfig(CONFIG_PATH);
    const sec = cfg?.sentences || {};
    const folderName = sec.folderName || DEFAULT_FOLDER_NAME;
    const baseUrl = ensureTrailingSlash(
      sec.baseUrl || `https://raw.githubusercontent.com/nicklian1927/english-trainer/resource/${folderName}/`
    );
    return {
      baseUrl,
      folderName,
      manifestFile: sec.manifestFile || 'manifest.json',
      files: Array.isArray(sec.files) ? sec.files : []
    };
  } catch (_) {
    return {
      baseUrl: DEFAULT_BASE_URL,
      folderName: DEFAULT_FOLDER_NAME,
      manifestFile: 'manifest.json',
      files: []
    };
  }
}

function normalizeDeck(parsed, sourceName) {
  const items = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.sentences) ? parsed.sentences : null);

  if (!items || items.length === 0) {
    throw new Error(`${sourceName} 必須是非空的 JSON 陣列（或包含 sentences 陣列）`);
  }
  if (!items.every(item => item && typeof item.en === 'string' && item.en.trim().length > 0)) {
    throw new Error(`${sourceName} 內的每筆資料都需要包含非空的 "en" 欄位`);
  }
  return { sentences: items };
}

function refreshDeckSelect() {
  const select = $('deckSelect');
  select.innerHTML = '';
  if (decks.size === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `（${activeSourceInfo.folderName} 內尚無可用 JSON 檔）`;
    select.appendChild(opt);
    return;
  }
  for (const [key, deck] of decks.entries()) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${deck.name}（${deck.sentences.length} 題）`;
    if (key === activeDeckKey) opt.selected = true;
    select.appendChild(opt);
  }
}

function updateDots() {
  const blindDots = $('blindDots').children;
  for (let i = 0; i < 3; i++) {
    blindDots[i].className = i < blindCount ? 'dot active-blind' : 'dot';
  }

  const readNum = Math.min(shadowCount, 5);
  const closeNum = Math.max(0, shadowCount - 5);
  $('readCountText').textContent = `${readNum} / 5`;
  $('closeCountText').textContent = `${closeNum} / 5`;

  const readDots = $('readDots').children;
  for (let i = 0; i < 5; i++) {
    readDots[i].className = i < readNum ? 'dot active-read' : 'dot';
  }

  const closeDots = $('closeDots').children;
  for (let i = 0; i < 5; i++) {
    closeDots[i].className = i < closeNum ? 'dot active-close' : 'dot';
  }
}

function renderAllSentencesList() {
  const listEl = $('allSentencesList');
  listEl.innerHTML = '';
  const wordOpts = { getRate: () => 1.0, voiceSelectEl: $('voiceSelect') };

  sentences.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `sentence-row${idx === currentIndex ? ' is-current' : ''}`;

    const main = document.createElement('div');
    main.className = 'sentence-row-main';

    const enDiv = document.createElement('div');
    enDiv.className = 'sentence-row-en';
    enDiv.appendChild(document.createTextNode(`${idx + 1}. `));
    appendInteractiveWords(enDiv, item.en, wordOpts);

    const zhDiv = document.createElement('div');
    zhDiv.className = 'sentence-row-zh';
    zhDiv.textContent = item.zh || '';

    main.append(enDiv, zhDiv);

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'btn-jump';
    jumpBtn.textContent = idx === currentIndex ? '目前題目' : '跳至此題';
    jumpBtn.addEventListener('click', () => {
      currentIndex = idx;
      renderCard();
    });

    row.append(main, jumpBtn);
    listEl.appendChild(row);
  });
}

function setAllSentencesOpen(open) {
  isAllSentencesOpen = Boolean(open);
  const panel = $('allSentencesPanel');
  const btn = $('toggleAllSentencesBtn');
  panel.hidden = !isAllSentencesOpen;
  panel.classList.toggle('open', isAllSentencesOpen);
  btn.setAttribute('aria-expanded', String(isAllSentencesOpen));
  btn.textContent = isAllSentencesOpen
    ? `▾ 縮起所有句子（共 ${sentences.length} 句）`
    : `▸ 展開所有句子（共 ${sentences.length} 句）`;
  if (isAllSentencesOpen) renderAllSentencesList();
}

function renderCard() {
  const item = sentences[currentIndex];
  if (!item) return;

  $('progressBadge').textContent = `第 ${currentIndex + 1} / ${sentences.length} 題`;
  const enEl = $('enText');
  enEl.innerHTML = '';
  appendInteractiveWords(enEl, item.en, { getRate: () => 1.0, voiceSelectEl: $('voiceSelect') });
  $('zhText').textContent = item.zh || '';

  if (isAllSentencesOpen) renderAllSentencesList();

  renderLinkingNotes($('notesList'), item.notes, (text, rate) => {
    speakText(text, rate, $('voiceSelect'));
  });

  blindCount = 0;
  shadowCount = 0;
  isRevealed = false;
  $('answerBox').classList.remove('visible');
  $('blindPlaceholder').style.display = 'block';
  $('revealBtn').style.display = 'flex';
  updateDots();
}

function activateDeck(key, elapsedMs = null) {
  const deck = decks.get(key);
  if (!deck) return;
  cancelSpeech();
  activeDeckKey = key;
  sentences = deck.sentences;
  currentIndex = 0;
  refreshDeckSelect();
  setPracticeEnabled(true);
  setAllSentencesOpen(false);
  const speedInfo = elapsedMs !== null ? `，耗時 ${elapsedMs} ms` : '';
  $('deckStatus').textContent =
    `目前檔案：${activeSourceInfo.baseUrl}${deck.name}（共 ${sentences.length} 題，已並行載入 ${decks.size} 個 JSON 檔${speedInfo}）`;
  renderCard();
}

function playFullSentence(rate) {
  if (!sentences[currentIndex]) return;
  speakText(sentences[currentIndex].en, rate, $('voiceSelect'));

  if (!isRevealed) {
    if (blindCount < 3) blindCount++;
  } else {
    if (shadowCount < 10) shadowCount++;
  }
  updateDots();
}

async function autoScanFolder(preserveSelection = false) {
  const startTime = performance.now();
  clearError();
  setPracticeEnabled(false);
  $('progressBadge').textContent = '掃描中...';

  activeSourceInfo = await resolveSentenceSourceConfig();
  $('deckSelect').title = `切換 ${activeSourceInfo.folderName} 內的 JSON 檔案`;
  $('deckStatus').innerHTML =
    `正在並行掃描 <code>${activeSourceInfo.baseUrl}</code>（資料夾：<code>${activeSourceInfo.folderName}</code>）內的 <code>.json</code> 檔案...`;

  const previousKey = preserveSelection ? activeDeckKey : '';
  decks.clear();

  try {
    const { itemsMap, errors } = await loadJsonFromSource({
      baseUrl: activeSourceInfo.baseUrl,
      manifestFile: activeSourceInfo.manifestFile,
      explicitFiles: activeSourceInfo.files,
      scanTimeoutMs: SCAN_TIMEOUT_MS,
      fileTimeoutMs: FILE_TIMEOUT_MS,
      allowManifest: true,
      normalizeFn: normalizeDeck
    });

    for (const [k, v] of itemsMap.entries()) {
      decks.set(k, v);
    }
    refreshDeckSelect();
    const elapsedMs = Math.round(performance.now() - startTime);

    if (errors.length > 0) {
      showError(`部分檔案讀取失敗：<br>${errors.join('<br>')}`);
    }

    if (decks.size > 0) {
      const targetKey = (previousKey && decks.has(previousKey))
        ? previousKey
        : decks.keys().next().value;
      activateDeck(targetKey, elapsedMs);
    } else {
      $('progressBadge').textContent = '無可用題庫';
      $('deckStatus').innerHTML = `<code>${activeSourceInfo.baseUrl}</code> 內沒有可用的 JSON 題庫。`;
    }
  } catch (err) {
    refreshDeckSelect();
    $('progressBadge').textContent = '無法自動掃描';
    showError(
      `自動掃描 <code>${activeSourceInfo.baseUrl}</code> 失敗：${err.message}` +
      `<br>請確認來源網址可公開存取並包含 <code>${activeSourceInfo.manifestFile}</code> 或目錄索引，或按右側「📄 手動選檔」。`
    );
    $('deckStatus').textContent = '自動掃描未完成，可手動選擇 JSON 檔案或檢查 config.json 設定。';
  }
}

async function handleManualFiles(fileList) {
  clearError();
  const { parsedList, errors } = await parseManualJsonFiles(
    fileList,
    normalizeDeck,
    [activeSourceInfo.manifestFile]
  );
  let firstKey = null;

  for (const item of parsedList) {
    decks.set(item.filename, {
      name: item.filename,
      url: null,
      ...item.normalized
    });
    if (!firstKey) firstKey = item.filename;
  }

  if (errors.length > 0) {
    showError(`部分手動檔案載入失敗：<br>${errors.join('<br>')}`);
  }
  if (firstKey) {
    activateDeck(firstKey);
  } else {
    refreshDeckSelect();
  }
}

$('deckSelect').addEventListener('change', e => {
  if (e.target.value && decks.has(e.target.value)) {
    clearError();
    activateDeck(e.target.value);
  }
});
$('rescanBtn').addEventListener('click', () => autoScanFolder(true));
$('manualPickBtn').addEventListener('click', () => $('filesInput').click());
$('toggleAllSentencesBtn').addEventListener('click', () => {
  if (sentences.length > 0) setAllSentencesOpen(!isAllSentencesOpen);
});
$('play10').addEventListener('click', () => playFullSentence(1.0));
$('play075').addEventListener('click', () => playFullSentence(0.75));
$('play05').addEventListener('click', () => playFullSentence(0.5));
$('revealBtn').addEventListener('click', () => {
  isRevealed = true;
  $('answerBox').classList.add('visible');
  $('blindPlaceholder').style.display = 'none';
  $('revealBtn').style.display = 'none';
});
$('prevBtn').addEventListener('click', () => {
  if (!sentences.length) return;
  currentIndex = (currentIndex - 1 + sentences.length) % sentences.length;
  renderCard();
});
$('nextBtn').addEventListener('click', () => {
  if (!sentences.length) return;
  currentIndex = (currentIndex + 1) % sentences.length;
  renderCard();
});
$('filesInput').addEventListener('change', e => {
  if (e.target.files?.length) handleManualFiles(e.target.files);
  e.target.value = '';
});

initVoiceSelector($('voiceSelect'));
autoScanFolder(false);
