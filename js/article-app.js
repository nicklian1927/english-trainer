import {
  initVoiceSelector,
  createUtterance,
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
const DEFAULT_FOLDER_NAME = 'articles_json';
const DEFAULT_BASE_URL = `https://raw.githubusercontent.com/nicklian1927/english-trainer/resource/${DEFAULT_FOLDER_NAME}/`;
const SCAN_TIMEOUT_MS = 1500;
const FILE_TIMEOUT_MS = 4000;

const articles = new Map();
let activeArticleKey = '';
let currentArticle = null;
let currentSentenceIndex = 0;
let wordRate = 1.0;
let isZhVisible = false;
let isAllSentencesOpen = false;
let articlePlaySessionId = 0;
let activeSourceInfo = {
  baseUrl: DEFAULT_BASE_URL,
  folderName: DEFAULT_FOLDER_NAME,
  manifestFile: 'manifest.json',
  files: []
};

const $ = id => document.getElementById(id);

function setArticleControlsEnabled(enabled) {
  [
    'playArticle10', 'playArticle075', 'playArticle05',
    'toggleZhBtn', 'toggleAllSentencesBtn',
    'prevSentenceBtn', 'nextSentenceBtn',
    'playSent10', 'playSent075', 'playSent05'
  ].forEach(id => {
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

async function resolveArticleSourceConfig() {
  try {
    const cfg = await loadSiteConfig(CONFIG_PATH);
    const sec = cfg?.articles || {};
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

function normalizeArticle(parsed, sourceName) {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error(`${sourceName} 必須是非空陣列`);
    if (!parsed.every(s => s && typeof s.en === 'string' && s.en.trim().length > 0)) {
      throw new Error(`${sourceName} 內的每筆資料都需要包含非空的 "en" 欄位`);
    }
    return {
      title: sourceName.replace(/\.json$/i, ''),
      zhTitle: '',
      sentences: parsed.map((s, idx) => ({
        paragraph: s.paragraph || Math.floor(idx / 3) + 1,
        en: s.en.trim(),
        zh: s.zh || '',
        notes: Array.isArray(s.notes) ? s.notes : []
      }))
    };
  }

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.sentences) && parsed.sentences.length > 0) {
      if (!parsed.sentences.every(s => s && typeof s.en === 'string' && s.en.trim().length > 0)) {
        throw new Error(`${sourceName} 的 sentences 內每筆都需要包含非空的 "en" 欄位`);
      }
      return {
        title: parsed.title || sourceName.replace(/\.json$/i, ''),
        zhTitle: parsed.zhTitle || parsed.zh || '',
        sentences: parsed.sentences.map(s => ({
          paragraph: s.paragraph || 1,
          en: s.en.trim(),
          zh: s.zh || '',
          notes: Array.isArray(s.notes) ? s.notes : []
        }))
      };
    }

    if (typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
      const paragraphs = parsed.content.split(/\n+/).map(p => p.trim()).filter(Boolean);
      const splitSentences = [];
      paragraphs.forEach((pText, pIdx) => {
        const parts = pText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [pText];
        parts.map(t => t.trim()).filter(Boolean).forEach(en => {
          splitSentences.push({ paragraph: pIdx + 1, en, zh: '', notes: [] });
        });
      });
      if (splitSentences.length === 0) {
        throw new Error(`${sourceName} 的 content 無法切分出有效句子`);
      }
      return {
        title: parsed.title || sourceName.replace(/\.json$/i, ''),
        zhTitle: parsed.zhTitle || '',
        sentences: splitSentences
      };
    }
  }

  throw new Error(`${sourceName} 格式不符（需為文章物件或句子陣列）`);
}

function refreshDeckSelect() {
  const select = $('deckSelect');
  select.innerHTML = '';
  if (articles.size === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `（${activeSourceInfo.folderName} 內尚無可用 JSON 檔）`;
    select.appendChild(opt);
    return;
  }
  for (const [key, art] of articles.entries()) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${art.title}（${art.name} · ${art.sentences.length} 句）`;
    if (key === activeArticleKey) opt.selected = true;
    select.appendChild(opt);
  }
}

function stopSpeaking() {
  articlePlaySessionId++;
  cancelSpeech();
  document.querySelectorAll('.sentence-span.reading').forEach(el => el.classList.remove('reading'));
  document.querySelectorAll('.clickable-word.speaking').forEach(el => el.classList.remove('speaking'));
}

function activateArticle(key, elapsedMs = null) {
  const art = articles.get(key);
  if (!art) return;
  stopSpeaking();
  activeArticleKey = key;
  currentArticle = art;
  currentSentenceIndex = 0;
  refreshDeckSelect();
  setArticleControlsEnabled(true);
  setAllSentencesOpen(false);
  const speedInfo = elapsedMs !== null ? `，耗時 ${elapsedMs} ms` : '';
  $('deckStatus').textContent =
    `目前檔案：${activeSourceInfo.baseUrl}${art.name}（共 ${art.sentences.length} 句，已並行載入 ${articles.size} 個 JSON 檔${speedInfo}）`;
  renderArticle();
  selectSentence(0, false);
}

function makeWordOptions(sentenceIdx = null) {
  return {
    getRate: () => wordRate,
    voiceSelectEl: $('voiceSelect'),
    onBeforeSpeak: () => {
      if (sentenceIdx !== null && sentenceIdx !== currentSentenceIndex) {
        selectSentence(sentenceIdx, false);
      }
      stopSpeaking();
    }
  };
}

function renderArticle() {
  if (!currentArticle) return;
  $('articleTitle').textContent = currentArticle.title;
  $('articleSubtitle').textContent =
    currentArticle.zhTitle || '點擊文章中的任意單字即可發音，或點擊句子檢視連音教學';

  const bodyEl = $('articleBody');
  const zhBoxEl = $('articleZhBox');
  bodyEl.innerHTML = '';
  zhBoxEl.innerHTML = '';

  const paragraphMap = new Map();
  currentArticle.sentences.forEach((s, idx) => {
    const pNum = s.paragraph || 1;
    if (!paragraphMap.has(pNum)) paragraphMap.set(pNum, []);
    paragraphMap.get(pNum).push({ ...s, idx });
  });

  for (const [, pSentences] of paragraphMap.entries()) {
    const pEl = document.createElement('p');
    pEl.className = 'article-paragraph';
    const zhParts = [];

    pSentences.forEach((s, i) => {
      const sSpan = document.createElement('span');
      sSpan.className = 'sentence-span';
      sSpan.dataset.idx = String(s.idx);
      sSpan.addEventListener('click', () => selectSentence(s.idx, false));
      appendInteractiveWords(sSpan, s.en, makeWordOptions(s.idx));
      pEl.appendChild(sSpan);

      if (i < pSentences.length - 1) pEl.appendChild(document.createTextNode(' '));
      if (s.zh) zhParts.push(s.zh);
    });

    bodyEl.appendChild(pEl);
    if (zhParts.length > 0) {
      const zhP = document.createElement('p');
      zhP.textContent = zhParts.join(' ');
      zhBoxEl.appendChild(zhP);
    }
  }
}

function renderAllSentencesList() {
  const listEl = $('allSentencesList');
  listEl.innerHTML = '';
  if (!currentArticle) return;

  currentArticle.sentences.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `sentence-row${idx === currentSentenceIndex ? ' is-current' : ''}`;
    row.addEventListener('click', () => selectSentence(idx, false));

    const enDiv = document.createElement('div');
    enDiv.className = 'sentence-row-en';
    enDiv.appendChild(document.createTextNode(`${idx + 1}. `));
    appendInteractiveWords(enDiv, item.en, makeWordOptions(idx));

    const zhDiv = document.createElement('div');
    zhDiv.className = 'sentence-row-zh';
    zhDiv.textContent = item.zh || '';

    row.append(enDiv, zhDiv);
    listEl.appendChild(row);
  });
}

function setAllSentencesOpen(open) {
  isAllSentencesOpen = Boolean(open);
  const panel = $('allSentencesPanel');
  const btn = $('toggleAllSentencesBtn');
  const count = currentArticle ? currentArticle.sentences.length : 0;
  panel.hidden = !isAllSentencesOpen;
  panel.classList.toggle('open', isAllSentencesOpen);
  btn.setAttribute('aria-expanded', String(isAllSentencesOpen));
  btn.textContent = isAllSentencesOpen
    ? `▾ 縮起所有斷句（共 ${count} 句）`
    : `▸ 展開所有斷句（共 ${count} 句）`;
  if (isAllSentencesOpen) renderAllSentencesList();
}

function selectSentence(index, shouldSpeak = false) {
  if (!currentArticle || index < 0 || index >= currentArticle.sentences.length) return;
  currentSentenceIndex = index;
  const total = currentArticle.sentences.length;
  const item = currentArticle.sentences[index];

  $('progressBadge').textContent = `第 ${index + 1} / ${total} 句`;
  $('focusSentenceLabel').textContent = `🔍 斷句精讀與連音教學（第 ${index + 1} / ${total} 句）`;

  document.querySelectorAll('.sentence-span').forEach(el => {
    el.classList.toggle('selected', Number(el.dataset.idx) === index);
  });

  const focusEn = $('focusEnText');
  focusEn.innerHTML = '';
  appendInteractiveWords(focusEn, item.en, makeWordOptions(index));
  $('focusZhText').textContent = item.zh || '';

  renderLinkingNotes(
    $('notesList'),
    item.notes,
    (text, rate) => {
      stopSpeaking();
      speakText(text, rate, $('voiceSelect'));
    },
    '本句尚無額外標註連音密碼，可直接點擊上方單字或使用「朗讀本句」反覆跟讀。'
  );

  if (isAllSentencesOpen) renderAllSentencesList();
  if (shouldSpeak) playCurrentSentence(1.0);
}

function playFullArticle(rate) {
  if (!currentArticle || currentArticle.sentences.length === 0) return;
  stopSpeaking();
  const sessionId = ++articlePlaySessionId;
  const list = currentArticle.sentences;

  function speakIndex(idx) {
    if (sessionId !== articlePlaySessionId || idx >= list.length) {
      document.querySelectorAll('.sentence-span.reading').forEach(el => el.classList.remove('reading'));
      return;
    }
    selectSentence(idx, false);
    document.querySelectorAll('.sentence-span').forEach(el => {
      el.classList.toggle('reading', Number(el.dataset.idx) === idx);
    });

    const utterance = createUtterance(list[idx].en, rate, $('voiceSelect'));
    utterance.onend = () => {
      if (sessionId === articlePlaySessionId) speakIndex(idx + 1);
    };
    window.speechSynthesis.speak(utterance);
  }

  speakIndex(0);
}

function playCurrentSentence(rate) {
  if (!currentArticle || !currentArticle.sentences[currentSentenceIndex]) return;
  stopSpeaking();
  const s = currentArticle.sentences[currentSentenceIndex];
  document.querySelectorAll('.sentence-span').forEach(el => {
    el.classList.toggle('reading', Number(el.dataset.idx) === currentSentenceIndex);
  });
  speakText(s.en, rate, $('voiceSelect'), () => {
    document.querySelectorAll('.sentence-span.reading').forEach(el => el.classList.remove('reading'));
  });
}

async function autoScanFolder(preserveSelection = false) {
  const startTime = performance.now();
  clearError();
  setArticleControlsEnabled(false);
  $('progressBadge').textContent = '掃描中...';
  $('articleTitle').textContent = '掃描文章中...';

  activeSourceInfo = await resolveArticleSourceConfig();
  $('deckSelect').title = `切換 ${activeSourceInfo.folderName} 內的 JSON 檔案`;
  $('deckStatus').innerHTML =
    `正在並行掃描並載入 <code>${activeSourceInfo.baseUrl}</code>（資料夾：<code>${activeSourceInfo.folderName}</code>）內的 <code>.json</code> 檔案...`;

  const previousKey = preserveSelection ? activeArticleKey : '';
  articles.clear();

  try {
    const { itemsMap, errors } = await loadJsonFromSource({
      baseUrl: activeSourceInfo.baseUrl,
      manifestFile: activeSourceInfo.manifestFile,
      explicitFiles: activeSourceInfo.files,
      scanTimeoutMs: SCAN_TIMEOUT_MS,
      fileTimeoutMs: FILE_TIMEOUT_MS,
      allowManifest: true,
      normalizeFn: normalizeArticle
    });

    for (const [k, v] of itemsMap.entries()) {
      articles.set(k, v);
    }
    refreshDeckSelect();
    const elapsedMs = Math.round(performance.now() - startTime);

    if (errors.length > 0) {
      showError(`部分檔案讀取失敗：<br>${errors.join('<br>')}`);
    }

    if (articles.size > 0) {
      const targetKey = (previousKey && articles.has(previousKey))
        ? previousKey
        : articles.keys().next().value;
      activateArticle(targetKey, elapsedMs);
    } else {
      $('progressBadge').textContent = '無可用文章';
      $('articleTitle').textContent = '無可用文章';
      $('deckStatus').innerHTML = `<code>${activeSourceInfo.baseUrl}</code> 內沒有可用的 JSON 文章。`;
    }
  } catch (err) {
    refreshDeckSelect();
    $('progressBadge').textContent = '無法自動掃描';
    $('articleTitle').textContent = '尚未載入文章';
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
    normalizeArticle,
    [activeSourceInfo.manifestFile]
  );
  let firstKey = null;

  for (const item of parsedList) {
    articles.set(item.filename, {
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
    activateArticle(firstKey);
  } else {
    refreshDeckSelect();
  }
}

$('deckSelect').addEventListener('change', e => {
  if (e.target.value && articles.has(e.target.value)) {
    clearError();
    activateArticle(e.target.value);
  }
});
$('rescanBtn').addEventListener('click', () => autoScanFolder(true));
$('manualPickBtn').addEventListener('click', () => $('filesInput').click());
$('playArticle10').addEventListener('click', () => playFullArticle(1.0));
$('playArticle075').addEventListener('click', () => playFullArticle(0.75));
$('playArticle05').addEventListener('click', () => playFullArticle(0.5));
$('stopAudioBtn').addEventListener('click', stopSpeaking);
$('wordRateToggleBtn').addEventListener('click', () => {
  wordRate = wordRate === 1.0 ? 0.75 : 1.0;
  $('wordRateToggleBtn').textContent = `🔊 單字發音：${wordRate === 1.0 ? '1.0x' : '0.75x'}`;
});
$('toggleZhBtn').addEventListener('click', () => {
  isZhVisible = !isZhVisible;
  $('articleZhBox').classList.toggle('visible', isZhVisible);
  $('toggleZhBtn').classList.toggle('active', isZhVisible);
  $('toggleZhBtn').textContent = isZhVisible ? '🌐 隱藏全文翻譯' : '🌐 顯示全文翻譯';
});
$('toggleAllSentencesBtn').addEventListener('click', () => {
  if (currentArticle?.sentences.length) setAllSentencesOpen(!isAllSentencesOpen);
});
$('prevSentenceBtn').addEventListener('click', () => {
  if (!currentArticle?.sentences.length) return;
  const len = currentArticle.sentences.length;
  selectSentence((currentSentenceIndex - 1 + len) % len, false);
});
$('nextSentenceBtn').addEventListener('click', () => {
  if (!currentArticle?.sentences.length) return;
  const len = currentArticle.sentences.length;
  selectSentence((currentSentenceIndex + 1) % len, false);
});
$('playSent10').addEventListener('click', () => playCurrentSentence(1.0));
$('playSent075').addEventListener('click', () => playCurrentSentence(0.75));
$('playSent05').addEventListener('click', () => playCurrentSentence(0.5));
$('filesInput').addEventListener('change', e => {
  if (e.target.files?.length) handleManualFiles(e.target.files);
  e.target.value = '';
});

initVoiceSelector($('voiceSelect'));
autoScanFolder(false);
