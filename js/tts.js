const WORD_REGEX = /^[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*$/;
const TOKEN_SPLIT_REGEX = /([A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*)/g;

let voices = [];

export function initVoiceSelector(selectEl) {
  function populate() {
    if (!window.speechSynthesis || !selectEl) return;
    voices = window.speechSynthesis
      .getVoices()
      .filter(v => v.lang.startsWith('en'))
      .sort((a, b) => (b.lang === 'en-US') - (a.lang === 'en-US'));

    if (voices.length === 0) return;
    selectEl.innerHTML = '';
    voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `語音引擎：${v.name} (${v.lang})`;
      selectEl.appendChild(opt);
    });
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = populate;
  }
  populate();
}

export function createUtterance(text, rate, voiceSelectEl) {
  const utterance = new SpeechSynthesisUtterance(text);
  const idx = voiceSelectEl ? Number(voiceSelectEl.value) : -1;
  if (idx >= 0 && voices[idx]) {
    utterance.voice = voices[idx];
  }
  utterance.lang = 'en-US';
  utterance.rate = rate;
  return utterance;
}

export function speakText(text, rate, voiceSelectEl, onEndCallback = null) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = createUtterance(text, rate, voiceSelectEl);
  if (typeof onEndCallback === 'function') {
    utterance.onend = onEndCallback;
    utterance.onerror = onEndCallback;
  }
  window.speechSynthesis.speak(utterance);
}

export function cancelSpeech() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

export function appendInteractiveWords(container, sentenceText, options = {}) {
  const {
    getRate = () => 1.0,
    voiceSelectEl = null,
    onBeforeSpeak = null
  } = options;

  const tokens = sentenceText.split(TOKEN_SPLIT_REGEX);
  tokens.forEach(token => {
    if (!token) return;
    if (WORD_REGEX.test(token)) {
      const span = document.createElement('span');
      span.className = 'clickable-word';
      span.textContent = token;
      span.title = `點擊朗讀：${token}`;
      span.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof onBeforeSpeak === 'function') {
          onBeforeSpeak(span);
        }
        document.querySelectorAll('.clickable-word.speaking').forEach(el => {
          el.classList.remove('speaking');
        });
        span.classList.add('speaking');
        speakText(token, getRate(), voiceSelectEl, () => {
          span.classList.remove('speaking');
        });
      });
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(token));
    }
  });
}
