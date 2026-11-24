const SPEED_BUTTONS = [
  { label: '🔊 1.0x', rate: 1.0, title: '原速單點聽' },
  { label: '🐢 0.75x', rate: 0.75, title: '慢速單點聽' },
  { label: '🐌 0.5x', rate: 0.5, title: '超慢速單點聽' }
];

export function renderLinkingNotes(containerEl, notes, onPlayChunk, emptyMessage = '') {
  containerEl.innerHTML = '';
  const list = Array.isArray(notes) ? notes : [];

  if (list.length === 0) {
    if (emptyMessage) {
      const empty = document.createElement('div');
      empty.className = 'empty-notes';
      empty.textContent = emptyMessage;
      containerEl.appendChild(empty);
    }
    return;
  }

  list.forEach(n => {
    const card = document.createElement('div');
    card.className = 'linking-item';

    const info = document.createElement('div');
    info.className = 'linking-info';

    const top = document.createElement('div');
    top.className = 'linking-top';

    const origSpan = document.createElement('span');
    origSpan.className = 'orig-chunk';
    origSpan.textContent = n.orig;

    const arrowSpan = document.createElement('span');
    arrowSpan.textContent = '➔';

    const phoneticSpan = document.createElement('span');
    phoneticSpan.className = 'phonetic';
    phoneticSpan.textContent = n.phonetic;

    top.append(origSpan, arrowSpan, phoneticSpan);

    const descDiv = document.createElement('div');
    descDiv.className = 'linking-desc';
    descDiv.textContent = n.desc;

    info.append(top, descDiv);

    const btns = document.createElement('div');
    btns.className = 'chunk-btns';

    const speakTarget = n.speakText || n.orig;
    SPEED_BUTTONS.forEach(cfg => {
      const btn = document.createElement('button');
      btn.className = 'btn-mini';
      btn.type = 'button';
      btn.textContent = cfg.label;
      btn.title = cfg.title;
      btn.addEventListener('click', () => onPlayChunk(speakTarget, cfg.rate));
      btns.appendChild(btn);
    });

    card.append(info, btns);
    containerEl.appendChild(card);
  });
}
