'use strict';

const IS_MAC = window.tanay.platform === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const MOD_SHIFT = IS_MAC ? '⌘⇧' : 'Ctrl+Shift+';

const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const captionEl = document.getElementById('caption');
const transcriptEl = document.getElementById('transcript');
const answerEl = document.getElementById('answer');
const metaEl = document.getElementById('meta');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const shotBtn = document.getElementById('shot');
const shotsEl = document.getElementById('shots');
const lightboxEl = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');

let raw = '';
let listening = false;
let placeholder = 'Waiting for a question…';
let pendingSwap = false; // a superseding answer is streaming in; keep the old text visible
let thinking = false; // model is working and has produced nothing yet

// Screenshots stay here until Send. The camera only queues them, so a capture
// can be reviewed (or removed) before anything reaches the model.
const MAX_SHOTS = 5;
let shots = [];

// Markdown-lite rendering and C++ colouring live in render.js, which is
// also required directly by the tests.
const { render, escapeHtml } = window.CloudyRender;


function paint() {
  if (raw) {
    answerEl.innerHTML = render(raw);
  } else if (thinking) {
    answerEl.innerHTML = '<p class="hint thinking"><span class="blink-dot"></span>thinking…</p>';
  } else {
    answerEl.innerHTML = `<p class="hint">${placeholder}</p>`;
  }
  answerEl.scrollTop = answerEl.scrollHeight;
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  dot.className = `dot ${cls || ''}`.trim();
}

// ------------------------------------------------------------------ composer
// The textarea grows with its content up to a cap, so a one-line question does
// not take panel space away from the answer.
function updateSendState() {
  // Send stays live for a screenshot-only turn: no text is needed when an
  // image is attached.
  sendBtn.disabled = !promptEl.value.trim() && shots.length === 0;
}

function growPrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 96)}px`;
  updateSendState();
}

function clearShots() {
  shots = [];
  closeLightbox();
  renderShots();
}

// --------------------------------------------------------------- previews
// Each captured image gets a thumbnail. Click the thumbnail for a full-size
// look, click × to drop it. Nothing leaves the panel until Send.
function renderShots() {
  shotsEl.hidden = shots.length === 0;
  shotsEl.textContent = '';
  shots.forEach((shot, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'shot';

    const open = document.createElement('button');
    open.className = 'shot-open';
    open.title = `Preview screenshot ${index + 1}`;
    const img = document.createElement('img');
    img.src = shot.dataUrl;
    img.alt = `Screenshot ${index + 1}`;
    open.appendChild(img);
    open.addEventListener('click', () => openLightbox(shot.id));

    const remove = document.createElement('button');
    remove.className = 'shot-x';
    remove.title = 'Remove screenshot';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      shots = shots.filter((item) => item.id !== shot.id);
      if (lightboxShotId === shot.id) closeLightbox();
      renderShots();
    });

    wrap.append(open, remove);
    shotsEl.appendChild(wrap);
  });
  updateSendState();
}

let lightboxShotId = null;

function openLightbox(id) {
  const shot = shots.find((item) => item.id === id);
  if (!shot) return;
  lightboxShotId = id;
  lightboxImg.src = shot.dataUrl;
  lightboxEl.hidden = false;
}

function closeLightbox() {
  lightboxShotId = null;
  lightboxEl.hidden = true;
  lightboxImg.removeAttribute('src');
}

lightboxEl.addEventListener('click', (event) => {
  if (event.target === lightboxEl || event.target.id === 'lightboxClose') closeLightbox();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !lightboxEl.hidden) {
    event.preventDefault();
    closeLightbox();
  }
});

function sendPrompt() {
  const typed = promptEl.value.trim();
  const images = shots.map((shot) => shot.dataUrl);
  if (!typed && !images.length) return;
  promptEl.value = '';
  growPrompt();
  clearShots();
  window.tanay.askText(typed, images);
}

promptEl.addEventListener('input', growPrompt);
promptEl.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter keeps the newline. IME composition must not send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt();
  }
});
sendBtn.addEventListener('click', sendPrompt);

let capturing = false;

/** Queue one captured image as a preview. Nothing is sent until Send. */
function queueShot(dataUrl) {
  if (!dataUrl) return false;
  if (shots.length >= MAX_SHOTS) {
    setStatus(`only ${MAX_SHOTS} screenshots per question`, 'error');
    return false;
  }
  shots.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    dataUrl,
  });
  renderShots();
  // Take the status line back from "capturing screen…".
  setStatus(listening ? 'listening' : 'idle', listening ? 'live' : '');
  return true;
}

shotBtn.addEventListener('click', async () => {
  if (capturing) return;
  if (shots.length >= MAX_SHOTS) {
    setStatus(`only ${MAX_SHOTS} screenshots per question`, 'error');
    return;
  }
  capturing = true;
  shotBtn.disabled = true;
  try {
    const result = await window.tanay.capture();
    if (result && result.ok) {
      queueShot(result.dataUrl);
    } else {
      setStatus('error', 'error'); // onError already spelled out the fix
    }
  } finally {
    capturing = false;
    shotBtn.disabled = false;
  }
});

// Global shortcut (⌘⇧S): main captured the screen and handed the image back.
window.tanay.onShot((payload) => {
  if (payload && payload.dataUrl) queueShot(payload.dataUrl);
});

// Global shortcut (⌘↵): send the composer exactly as the ↵ button would.
window.tanay.onSendRequest(() => sendPrompt());

// The full transcript is a chat: every finished utterance becomes a bubble on
// the side of the person who said it. "them" = system audio (left),
// "me" = microphone (right).
let transcriptParts = [];
function renderTranscript() {
  transcriptEl.innerHTML = transcriptParts
    .map(
      (part) =>
        `<div class="msg ${part.speaker === 'me' ? 'me' : 'them'}">` +
        `<p class="bubble">${escapeHtml(part.text)}</p></div>`
    )
    .join('');
  // Scroll after layout, otherwise scrollHeight is still the pre-render value
  // and the newest line stays just below the fold.
  requestAnimationFrame(() => {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });
}

function normaliseTurn(payload) {
  if (typeof payload === 'string') return { text: payload, speaker: 'them' };
  if (!payload || !payload.text) return null;
  return { text: String(payload.text), speaker: payload.speaker === 'me' ? 'me' : 'them' };
}

// Live caption: the provisional bubble for whoever is talking right now.
function showCaption(payload) {
  const turn = normaliseTurn(payload);
  if (!turn) {
    captionEl.hidden = true;
    captionEl.textContent = '';
    captionEl.className = 'live';
    return;
  }
  captionEl.hidden = false;
  captionEl.textContent = turn.text;
  captionEl.className = `live ${turn.speaker}`;
}

window.tanay.onCaption(showCaption);

window.tanay.onTranscript((payload) => {
  const turn = normaliseTurn(payload);
  if (!turn) return;
  transcriptParts.push(turn);
  renderTranscript();
});

window.tanay.onTranscriptReset(() => {
  transcriptParts = [];
  renderTranscript();
  showCaption(null);
});

window.tanay.onAnswerStart(() => {
  document.getElementById('actions').hidden = true;
  shotBtn.disabled = false;
  const lastTurn = transcriptParts[transcriptParts.length - 1];
  document.getElementById('answerFor').textContent = lastTurn
    ? lastTurn.speaker === 'me'
      ? 'answering you'
      : 'answering them'
    : '';
  // A new question was asked while the previous answer is still on screen.
  // Keep the existing text visible, dimmed, and swap it only when new tokens
  // actually exist — otherwise the panel blanks mid-read.
  if (raw) {
    pendingSwap = true;
    answerEl.classList.add('stale');
  } else {
    thinking = true;
    paint();
  }
  setStatus('thinking…', 'busy');
});

window.tanay.onAnswerDelta((delta) => {
  if (pendingSwap) {
    raw = '';
    pendingSwap = false;
    answerEl.classList.remove('stale');
  }
  thinking = false;
  raw += delta;
  paint();
  setStatus('answering', 'busy');
});

window.tanay.onAnswerEnd(() => {
  placeholder = 'Waiting for a question…';
  pendingSwap = false;
  thinking = false;
  answerEl.classList.remove('stale');
  paint();
  setStatus(listening ? 'listening' : 'idle', listening ? 'live' : '');
});

window.tanay.onStatus((s) => {
  shotBtn.disabled = s === 'capturing';
  if (s === 'listening') {
    listening = true;
    document.getElementById('actions').hidden = true;
    setStatus('listening', 'live');
    document.getElementById('listen').classList.add('on');
  } else if (s === 'idle') {
    listening = false;
    setStatus('idle', '');
    document.getElementById('listen').classList.remove('on');
  } else if (s === 'capturing') {
    setStatus('capturing screen…', 'busy');
  } else if (s === 'loading') {
    setStatus('loading speech model…', 'busy');
  } else if (s.startsWith && s.startsWith('loading speech model')) {
    setStatus(s, 'busy');
  } else if (s === 'thinking') {
    setStatus('thinking…', 'busy');
  } else if (s === 'error') {
    setStatus('error', 'error');
  }
});

window.tanay.onError((message) => {
  thinking = false;
  pendingSwap = false;
  shotBtn.disabled = false;
  raw = `**${message.split('\n')[0]}**\n\n${message.split('\n').slice(1).join('\n')}`;
  paint();
  setStatus('error', 'error');
  // A permission problem has a fix the user can click; anything else is just text.
  const actions = document.getElementById('actions');
  const micIssue = /microphone/i.test(message);
  const screenIssue = /screen|system audio|recording/i.test(message);
  actions.hidden = !(micIssue || screenIssue);
  document.getElementById('micSettings').hidden = !micIssue;
  document.getElementById('screenSettings').hidden = !screenIssue;
});

window.tanay.onMeta((meta) => {
  metaEl.textContent = meta;
  // Manual mode advertises the hotkey in the footer; mirror it in the placeholder.
  const keyMatch = /·\s*([^·]{1,24}?)\s+to answer/.exec(meta);
  const answerKey = keyMatch ? keyMatch[1] : `${MOD}J`;
  placeholder = `Listening — press ${answerKey} to answer`;
  if (!raw) paint();
});

// The header buttons and the composer carry macOS symbols in index.html. On
// Windows and Linux, spell the same shortcuts out instead.
if (!IS_MAC) {
  const swap = (s) =>
    String(s)
      .replace(/⌘⇧/g, 'Ctrl+Shift+')
      .replace(/⌘↵/g, 'Ctrl+Enter')
      .replace(/⏎/g, 'Enter')
      .replace(/⌘/g, 'Ctrl+');
  for (const el of document.querySelectorAll('[title]')) el.title = swap(el.title);
  promptEl.placeholder = swap(promptEl.placeholder);
}

document.getElementById('listen').addEventListener('click', () => window.tanay.listen());
document.getElementById('clear').addEventListener('click', () => {
  raw = '';
  thinking = false;
  pendingSwap = false;
  showCaption(null);
  transcriptParts = [];
  promptEl.value = '';
  growPrompt();
  clearShots();
  renderTranscript();
  paint();
  window.tanay.clear();
});
document.getElementById('hide').addEventListener('click', () => window.tanay.close());
document.getElementById('settings').addEventListener('click', () => window.tanay.settings());
document.getElementById('micSettings').addEventListener('click', () => window.tanay.openMicSettings());
document.getElementById('screenSettings').addEventListener('click', () => window.tanay.openScreenSettings());

growPrompt();
paint();
