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

const CONFIG_PATH = './config.json';
const DEFAULT_FOLDER_NAME = 'toeic_json';
const DEFAULT_BASE_URL = `./${DEFAULT_FOLDER_NAME}/`;
const SCAN_TIMEOUT_MS = 1500;
const FILE_TIMEOUT_MS = 4000;

const SPEED_BUTTONS = [
  { label: '🔊 1.0x', rate: 1.0, title: '原速單點聽', primary: true },
  { label: '🐢 0.75x', rate: 0.75, title: '慢速單點聽', primary: false },
  { label: '🐌 0.5x', rate: 0.5, title: '超慢速單點聽', primary: false }
];

const decks = new Map();
let activeDeckKey = '';
let currentData = null;
let currentPartIdx = 0;
let currentBlockIdx = 0;
let isRevealed = false;
let blindCount = 0;
let shadowCount = 0;
let wordRate = 1.0;
let activeSourceInfo = {
  baseUrl: DEFAULT_BASE_URL,
  folderName: DEFAULT_FOLDER_NAME,
  manifestFile: 'manifest.json',
  files: []
};

const $ = id => document.getElementById(id);

function setControlsEnabled(enabled) {
  [
    'play10', 'play075', 'play05', 'stopBtn',
    'revealBtn', 'prevBtn', 'nextBtn',
    'blockSelect', 'wordRateToggleBtn', 'wordRateToggleBtnQ'
  ].forEach(id => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
  document.querySelectorAll('.part-tab').forEach(tab => {
    tab.disabled = !enabled;
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

async function resolveToeicSourceConfig() {
  try {
    const cfg = await loadSiteConfig(CONFIG_PATH);
    const sec = cfg?.toeic || {};
    const folderName = sec.folderName || DEFAULT_FOLDER_NAME;
    const baseUrl = ensureTrailingSlash(sec.baseUrl || `./${folderName}/`);
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

function normalizeToeicDeck(parsed, sourceName) {
  if (parsed && Array.isArray(parsed.parts) && parsed.parts.length > 0) {
    const validParts = parsed.parts.filter(p => p && Array.isArray(p.blocks) && p.blocks.length > 0);
    if (validParts.length === 0) {
      throw new Error(`${sourceName} 的 parts 內沒有可訓練的 blocks`);
    }
    return {
      title: parsed.title || sourceName.replace(/\.json$/i, ''),
      parts: validParts
    };
  }

  if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.en) {
    const convertedBlocks = parsed.map((item, idx) => ({
      block_id: `custom_q${idx + 1}`,
      block_title: `Custom Sentence ${idx + 1}`,
      context_type: 'single_question',
      passage: [],
      questions: [{
        number: idx + 1,
        prompt: item.en,
        prompt_zh: item.zh || '',
        options: [],
        linking_notes: Array.isArray(item.notes) ? item.notes : []
      }]
    }));
    return {
      title: sourceName.replace(/\.json$/i, ''),
      parts: [
        {
          part_id: 'part2',
          part_title: 'Part 2: Custom Sentences',
          directions: 'Listen carefully to each sentence and practice shadowing.',
          blocks: convertedBlocks
        }
      ]
    };
  }

  throw new Error(`${sourceName} 格式不符（需為包含 parts 陣列的 TOEIC 題庫或句子陣列）`);
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
    opt.textContent = `${deck.title}（${deck.name}）`;
    if (key === activeDeckKey) opt.selected = true;
    select.appendChild(opt);
  }
}

function syncWordRateButtons() {
  const label = `🔊 單字發音：${wordRate === 1.0 ? '1.0x' : '0.75x'}`;
  const isNormal = wordRate === 1.0;
  ['wordRateToggleBtn', 'wordRateToggleBtnQ'].forEach(id => {
    const btn = $(id);
    if (!btn) return;
    btn.textContent = label;
    btn.classList.toggle('active', isNormal);
  });
}

function createSpeedButtons(getTargetText) {
  const wrap = document.createElement('div');
  wrap.className = 'chunk-btns';
  SPEED_BUTTONS.forEach(cfg => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cfg.primary ? 'btn-mini btn-mini-primary' : 'btn-mini';
    btn.textContent = cfg.label;
    btn.title = cfg.title;
    btn.addEventListener('click', () => speakText(getTargetText(), cfg.rate, $('voiceSelect')));
    wrap.appendChild(btn);
  });
  return wrap;
}

function wordOptions() {
  return {
    getRate: () => wordRate,
    voiceSelectEl: $('voiceSelect'),
    onBeforeSpeak: () => {
      document.querySelectorAll('.clickable-word.speaking').forEach(el => el.classList.remove('speaking'));
    }
  };
}

function buildBlockSpeechScript(block) {
  const lines = [];
  if (Array.isArray(block.passage) && block.passage.length > 0) {
    block.passage.forEach(p => {
      if (p?.en) lines.push(p.en);
    });
  }
  (block.questions || []).forEach(q => {
    if (typeof q.number === 'number') {
      lines.push(`Number ${q.number}. ${q.prompt}`);
    } else if (q.prompt) {
      lines.push(q.prompt);
    }
    if (Array.isArray(q.options) && q.options.length > 0) {
      q.options.forEach(opt => {
        lines.push(`${opt.label}. ${opt.en}`);
      });
    }
  });
  return lines.join(' ... ');
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

function syncPartTabs() {
  const tabs = document.querySelectorAll('.part-tab');
  const partCount = currentData?.parts?.length || 0;
  tabs.forEach((tab, idx) => {
    const exists = idx < partCount;
    tab.style.display = exists ? '' : 'none';
    tab.classList.toggle('active', idx === currentPartIdx);
  });
}

function renderBlock() {
  cancelSpeech();
  if (!currentData?.parts?.[currentPartIdx]?.blocks?.[currentBlockIdx]) return;

  const part = currentData.parts[currentPartIdx];
  const block = part.blocks[currentBlockIdx];

  isRevealed = false;
  blindCount = 0;
  shadowCount = 0;
  updateDots();

  $('blindPlaceholder').style.display = 'block';
  $('answerBox').classList.remove('visible');
  $('revealBtn').textContent = '👁️ 揭曉本區塊原文、題目與連音解析';

  syncPartTabs();
  const partLabel = (part.part_id || `part${currentPartIdx + 1}`).toUpperCase();
  $('progressBadge').textContent = `${partLabel} · 區塊 ${currentBlockIdx + 1} / ${part.blocks.length}`;
  $('directionsText').textContent = part.directions || '本區塊無額外測驗說明。';

  const blockSelect = $('blockSelect');
  blockSelect.innerHTML = '';
  part.blocks.forEach((b, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = b.block_title || `Block ${idx + 1}`;
    if (idx === currentBlockIdx) opt.selected = true;
    blockSelect.appendChild(opt);
  });

  const passageSection = $('passageSection');
  const passageList = $('passageList');
  if (Array.isArray(block.passage) && block.passage.length > 0) {
    passageSection.style.display = 'block';
    passageList.innerHTML = '';
    block.passage.forEach(line => {
      const div = document.createElement('div');
      div.className = 'line-item';

      const content = document.createElement('div');
      content.className = 'line-content';

      const topLine = document.createElement('div');
      if (line.speaker) {
        const speaker = document.createElement('span');
        speaker.className = 'speaker-tag';
        speaker.textContent = line.speaker;
        topLine.appendChild(speaker);
      }

      const enSpan = document.createElement('span');
      enSpan.className = 'en-text';
      appendInteractiveWords(enSpan, line.en || '', wordOptions());
      topLine.appendChild(enSpan);

      const zhDiv = document.createElement('div');
      zhDiv.className = 'zh-text';
      zhDiv.textContent = line.zh || '';

      content.append(topLine, zhDiv);
      div.append(content, createSpeedButtons(() => line.en || ''));
      passageList.appendChild(div);
    });
  } else {
    passageSection.style.display = 'none';
    passageList.innerHTML = '';
  }

  const questionsList = $('questionsList');
  questionsList.innerHTML = '';
  let allNotes = [];

  (block.questions || []).forEach(q => {
    if (Array.isArray(q.linking_notes)) {
      allNotes = allNotes.concat(q.linking_notes);
    }

    const qDiv = document.createElement('div');
    qDiv.className = 'question-card';
    const qNumLabel = typeof q.number === 'number' ? `Q${q.number}` : (q.number || 'Q');

    const qHeader = document.createElement('div');
    qHeader.className = 'q-header';

    const qTextWrap = document.createElement('div');
    qTextWrap.className = 'q-text-wrap';

    const qTitle = document.createElement('div');
    qTitle.className = 'q-title';
    qTitle.appendChild(document.createTextNode(`${qNumLabel}. `));
    appendInteractiveWords(qTitle, q.prompt || '', wordOptions());
    qTextWrap.appendChild(qTitle);

    if (q.prompt_zh) {
      const qZh = document.createElement('div');
      qZh.className = 'zh-text';
      qZh.textContent = q.prompt_zh;
      qTextWrap.appendChild(qZh);
    }

    qHeader.append(qTextWrap, createSpeedButtons(() => q.prompt || ''));
    qDiv.appendChild(qHeader);

    if (Array.isArray(q.options) && q.options.length > 0) {
      const optList = document.createElement('div');
      optList.className = 'option-list';
      q.options.forEach(o => {
        const row = document.createElement('div');
        row.className = 'option-row';

        const left = document.createElement('div');
        left.className = 'option-left';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'option-label';
        labelSpan.textContent = `(${o.label})`;

        const enSpan = document.createElement('span');
        enSpan.className = 'en-text';
        appendInteractiveWords(enSpan, o.en || '', wordOptions());

        const zhDiv = document.createElement('div');
        zhDiv.className = 'zh-text option-zh';
        zhDiv.textContent = o.zh || '';

        left.append(labelSpan, enSpan, zhDiv);
        row.append(left, createSpeedButtons(() => o.en || ''));
        optList.appendChild(row);
      });
      qDiv.appendChild(optList);
    }

    questionsList.appendChild(qDiv);
  });

  const linkingSection = $('linkingSection');
  const linkingList = $('linkingList');
  if (allNotes.length > 0) {
    linkingSection.style.display = 'block';
    linkingList.innerHTML = '';
    allNotes.forEach(n => {
      const orig = n.orig || n.phrase || '';
      const speakStr = n.speakText || orig;
      const phonetic = n.phonetic || '';
      const desc = n.desc || n.note || '';

      const item = document.createElement('div');
      item.className = 'linking-item';

      const info = document.createElement('div');
      info.className = 'linking-info';

      const top = document.createElement('div');
      top.className = 'linking-top';

      const origSpan = document.createElement('span');
      origSpan.className = 'orig-chunk';
      origSpan.textContent = orig;
      top.appendChild(origSpan);

      if (phonetic) {
        const arrow = document.createElement('span');
        arrow.textContent = '➔';
        const phSpan = document.createElement('span');
        phSpan.className = 'phonetic';
        phSpan.textContent = phonetic;
        top.append(arrow, phSpan);
      }

      const descDiv = document.createElement('div');
      descDiv.className = 'linking-desc';
      descDiv.textContent = desc;

      info.append(top, descDiv);
      item.append(info, createSpeedButtons(() => speakStr));
      linkingList.appendChild(item);
    });
  } else {
    linkingSection.style.display = 'none';
    linkingList.innerHTML = '';
  }

  $('prevBtn').disabled = (currentPartIdx === 0 && currentBlockIdx === 0);
  $('nextBtn').disabled = (
    currentPartIdx === currentData.parts.length - 1 &&
    currentBlockIdx === part.blocks.length - 1
  );
}

function activateDeck(key, elapsedMs = null) {
  const deck = decks.get(key);
  if (!deck) return;
  cancelSpeech();
  activeDeckKey = key;
  currentData = deck;
  currentPartIdx = 0;
  currentBlockIdx = 0;
  refreshDeckSelect();
  setControlsEnabled(true);
  const speedInfo = elapsedMs !== null ? `，耗時 ${elapsedMs} ms` : '';
  const sourceLabel = deck.url ? `${activeSourceInfo.baseUrl}${deck.name}` : `本機檔案：${deck.name}`;
  $('deckStatus').textContent =
    `目前題庫：${sourceLabel}（共 ${deck.parts.length} 個 Part，已載入 ${decks.size} 個 JSON 檔${speedInfo}）`;
  renderBlock();
}

function playCurrentBlock(rate) {
  const block = currentData?.parts?.[currentPartIdx]?.blocks?.[currentBlockIdx];
  if (!block) return;
  speakText(buildBlockSpeechScript(block), rate, $('voiceSelect'));
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
  setControlsEnabled(false);
  $('progressBadge').textContent = '掃描中...';

  activeSourceInfo = await resolveToeicSourceConfig();
  $('deckSelect').title = `切換 ${activeSourceInfo.folderName} 內的 JSON 檔案`;
  $('deckStatus').innerHTML =
    `正在並行掃描並載入 <code>${activeSourceInfo.baseUrl}</code>（資料夾：<code>${activeSourceInfo.folderName}</code>）內的 <code>.json</code> 檔案...`;

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
      normalizeFn: normalizeToeicDeck
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
      $('deckStatus').innerHTML = `<code>${activeSourceInfo.baseUrl}</code> 內沒有可用的 JSON 題庫，可按右側「📄 手動選檔」。`;
    }
  } catch (err) {
    refreshDeckSelect();
    $('progressBadge').textContent = '無法自動掃描';
    showError(
      `自動掃描 <code>${activeSourceInfo.baseUrl}</code> 失敗：${err.message}` +
      `<br>若以 <code>file://</code> 開啟或缺少 <code>${activeSourceInfo.manifestFile}</code>，請改用本機伺服器或按右側「📄 手動選檔」。`
    );
    $('deckStatus').textContent = '自動掃描未完成，可手動選擇 JSON 檔案或檢查 config.json 設定。';
  }
}

async function handleManualFiles(fileList) {
  clearError();
  const { parsedList, errors } = await parseManualJsonFiles(
    fileList,
    normalizeToeicDeck,
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

function toggleWordRate() {
  wordRate = wordRate === 1.0 ? 0.75 : 1.0;
  syncWordRateButtons();
}

$('deckSelect').addEventListener('change', e => {
  if (e.target.value && decks.has(e.target.value)) {
    clearError();
    activateDeck(e.target.value);
  }
});
$('rescanBtn').addEventListener('click', () => autoScanFolder(true));
$('manualPickBtn').addEventListener('click', () => $('filesInput').click());
$('filesInput').addEventListener('change', e => {
  if (e.target.files?.length) handleManualFiles(e.target.files);
  e.target.value = '';
});

$('blockSelect').addEventListener('change', e => {
  currentBlockIdx = parseInt(e.target.value, 10) || 0;
  renderBlock();
});

document.querySelectorAll('.part-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const idx = parseInt(tab.dataset.part, 10);
    if (currentData?.parts?.[idx]) {
      currentPartIdx = idx;
      currentBlockIdx = 0;
      renderBlock();
    }
  });
});

$('toggleDirectionsBtn').addEventListener('click', () => {
  $('directionsText').classList.toggle('open');
});

$('play10').addEventListener('click', () => playCurrentBlock(1.0));
$('play075').addEventListener('click', () => playCurrentBlock(0.75));
$('play05').addEventListener('click', () => playCurrentBlock(0.5));
$('stopBtn').addEventListener('click', cancelSpeech);
$('wordRateToggleBtn').addEventListener('click', toggleWordRate);
$('wordRateToggleBtnQ').addEventListener('click', toggleWordRate);

$('revealBtn').addEventListener('click', () => {
  isRevealed = !isRevealed;
  if (isRevealed) {
    $('blindPlaceholder').style.display = 'none';
    $('answerBox').classList.add('visible');
    $('revealBtn').textContent = '🙈 重新隱藏文字（回到盲聽狀態）';
  } else {
    $('blindPlaceholder').style.display = 'block';
    $('answerBox').classList.remove('visible');
    $('revealBtn').textContent = '👁️ 揭曉本區塊原文、題目與連音解析';
  }
});

$('prevBtn').addEventListener('click', () => {
  if (!currentData?.parts?.length) return;
  if (currentBlockIdx > 0) {
    currentBlockIdx--;
  } else if (currentPartIdx > 0) {
    currentPartIdx--;
    currentBlockIdx = currentData.parts[currentPartIdx].blocks.length - 1;
  }
  renderBlock();
});

$('nextBtn').addEventListener('click', () => {
  if (!currentData?.parts?.length) return;
  const part = currentData.parts[currentPartIdx];
  if (currentBlockIdx < part.blocks.length - 1) {
    currentBlockIdx++;
  } else if (currentPartIdx < currentData.parts.length - 1) {
    currentPartIdx++;
    currentBlockIdx = 0;
  }
  renderBlock();
});

syncWordRateButtons();
initVoiceSelector($('voiceSelect'));
autoScanFolder(false);
