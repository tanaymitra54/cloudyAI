'use strict';

const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const captionEl = document.getElementById('caption');
const transcriptEl = document.getElementById('transcript');
const answerEl = document.getElementById('answer');
const metaEl = document.getElementById('meta');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const shotBtn = document.getElementById('shot');

let raw = '';
let listening = false;
let placeholder = 'Waiting for a question…';
let pendingSwap = false; // a superseding answer is streaming in; keep the old text visible
let thinking = false; // model is working and has produced nothing yet

// Markdown-lite rendering and C++ colouring live in render.js, which is
// also required directly by the tests.
const { render } = window.CloudyRender;


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
function growPrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 96)}px`;
  sendBtn.disabled = !promptEl.value.trim();
}

function takePrompt() {
  const text = promptEl.value.trim();
  promptEl.value = '';
  growPrompt();
  return text;
}

function sendTyped() {
  const text = takePrompt();
  if (text) window.tanay.askText(text);
}

promptEl.addEventListener('input', growPrompt);
promptEl.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter keeps the newline. IME composition must not send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendTyped();
  }
});
sendBtn.addEventListener('click', sendTyped);
shotBtn.addEventListener('click', async () => {
  shotBtn.disabled = true;
  const typed = promptEl.value;
  // The box is only cleared once the capture really happened, so a permission
  // error does not swallow a question the user just wrote.
  const captured = await window.tanay.screenshot(typed.trim());
  if (captured && promptEl.value === typed) {
    promptEl.value = '';
    growPrompt();
  }
  shotBtn.disabled = false;
});

window.tanay.onCaption((text) => {
  captionEl.textContent = text;
});

// The full transcript: every finished utterance, appended and never truncated.
// This is what you read to confirm exactly what the interviewer asked.
let transcriptParts = [];
function renderTranscript() {
  transcriptEl.innerHTML = transcriptParts
    .map((part) => `<p>${escapeHtml(part)}</p>`)
    .join('');
  // Scroll after layout, otherwise scrollHeight is still the pre-render value
  // and the newest line stays just below the fold.
  requestAnimationFrame(() => {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });
}

window.tanay.onTranscript((text) => {
  if (!text) return;
  transcriptParts.push(text);
  renderTranscript();
});

window.tanay.onTranscriptReset(() => {
  transcriptParts = [];
  renderTranscript();
});

window.tanay.onAnswerStart(() => {
  document.getElementById('actions').hidden = true;
  shotBtn.disabled = false;
  // A longer version of the question arrived (the speculative answer was
  // superseded). Keep the existing text on screen, dimmed, and swap it only
  // when new tokens actually exist — otherwise the panel blanks mid-read.
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
  placeholder = meta.includes('⌘J') ? 'Listening — press ⌘J to answer' : 'Waiting for a question…';
  if (!raw) paint();
});

document.getElementById('listen').addEventListener('click', () => window.tanay.listen());
document.getElementById('clear').addEventListener('click', () => {
  raw = '';
  thinking = false;
  pendingSwap = false;
  captionEl.textContent = '';
  transcriptParts = [];
  promptEl.value = '';
  growPrompt();
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
