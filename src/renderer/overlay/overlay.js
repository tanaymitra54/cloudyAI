'use strict';

const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const captionEl = document.getElementById('caption');
const transcriptEl = document.getElementById('transcript');
const answerEl = document.getElementById('answer');
const metaEl = document.getElementById('meta');

let raw = '';
let listening = false;
let placeholder = 'Waiting for a question…';
let pendingSwap = false; // a superseding answer is streaming in; keep the old text visible
let thinking = false; // model is working and has produced nothing yet

// Markdown-lite: enough for the shapes the prompt asks for (bullets, bold,
// headings, inline code, fenced blocks, rules) without pulling in a renderer.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

function render(md) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let inList = false;
  let lang = '';

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCode) {
        closeList();
        lang = line.slice(3).trim();
        out.push(lang === 'mermaid' ? '<pre><code class="mermaid">' : '<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(escapeHtml(line.replace(/^\s*[-*]\s+/, '')))}</li>`);
      continue;
    }
    closeList();
    if (/^#{1,6}\s/.test(line)) {
      out.push(`<h3>${inline(escapeHtml(line.replace(/^#{1,6}\s+/, '')))}</h3>`);
    } else if (/^\s*(\*\s*\*\s*\*|---)\s*$/.test(line)) {
      out.push('<hr/>');
    } else if (line.trim() === '') {
      continue;
    } else {
      out.push(`<p>${inline(escapeHtml(line))}</p>`);
    }
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('');
}

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
  if (s === 'listening') {
    listening = true;
    document.getElementById('actions').hidden = true;
    setStatus('listening', 'live');
    document.getElementById('listen').classList.add('on');
  } else if (s === 'idle') {
    listening = false;
    setStatus('idle', '');
    document.getElementById('listen').classList.remove('on');
  } else if (s === 'thinking') {
    setStatus('thinking…', 'busy');
  } else if (s === 'error') {
    setStatus('error', 'error');
  }
});

window.tanay.onError((message) => {
  thinking = false;
  pendingSwap = false;
  raw = `**${message.split('\n')[0]}**\n\n${message.split('\n').slice(1).join('\n')}`;
  paint();
  setStatus('error', 'error');
  // A permission problem has a fix the user can click; anything else is just text.
  const permissionIssue = /microphone|permission/i.test(message);
  document.getElementById('actions').hidden = !permissionIssue;
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
  renderTranscript();
  paint();
  window.tanay.clear();
});
document.getElementById('hide').addEventListener('click', () => window.tanay.close());
document.getElementById('settings').addEventListener('click', () => window.tanay.settings());
document.getElementById('micSettings').addEventListener('click', () => window.tanay.openMicSettings());

paint();
