'use strict';

// Session documents: the CV and the job description the answers should follow.
//
// Uploads are copied into <userData>/context so deleting the original from
// Downloads does not quietly empty the context. Text is extracted once per file
// version and cached, because extraction of a multi-page PDF is far too slow to
// repeat before every answer.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const pdf = require('pdf-parse');

// Long enough for a full CV or a detailed posting, small enough that the
// prompt (and the bill) stays bounded.
const MAX_CHARS = 20000;
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = new Set(['.pdf', '.txt', '.md', '.markdown']);

const cache = new Map(); // absolute path -> { mtimeMs, size, text }

function contextDir() {
  return path.join(app.getPath('userData'), 'context');
}

function isPdf(file) {
  return path.extname(file).toLowerCase() === '.pdf';
}

/** Collapse PDF line breaks and repeated blank lines so the text is readable. */
function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extract(file) {
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;

  let raw;
  if (isPdf(file)) {
    const parsed = await pdf(fs.readFileSync(file));
    raw = parsed.text || '';
  } else {
    raw = fs.readFileSync(file, 'utf8');
  }

  const text = tidy(raw).slice(0, MAX_CHARS);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/**
 * Text for a configured document path. Returns '' when nothing is configured;
 * throws with a readable message when a file exists but cannot be read.
 */
async function loadText(file, label) {
  if (!file) return '';
  try {
    if (!fs.existsSync(file)) throw new Error('the file is gone — upload it again');
    return await extract(file);
  } catch (err) {
    throw new Error(`Could not read the ${label}: ${err.message}`);
  }
}

/**
 * Copy an uploaded CV / job description into the context folder and prove it
 * yields text. Overwrites the previous file of the same kind, so there is
 * exactly one of each and nothing accumulates.
 */
async function importDocument(kind, sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED.has(ext)) {
    throw new Error('Use a PDF, .txt or .md file.');
  }
  const stat = fs.statSync(sourcePath);
  if (stat.size > MAX_BYTES) {
    throw new Error('That file is larger than 15 MB.');
  }

  const dir = contextDir();
  fs.mkdirSync(dir, { recursive: true });

  // Drop the previous copy (whatever its extension) before writing the new one.
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${kind}.`)) fs.rmSync(path.join(dir, name), { force: true });
  }

  const target = path.join(dir, `${kind}${ext}`);
  fs.copyFileSync(sourcePath, target);

  let text;
  try {
    text = await extract(target);
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw new Error(
      isPdf(sourcePath)
        ? `That PDF could not be read (${err.message}). If it is a scan, paste the text instead.`
        : `That file could not be read (${err.message}).`
    );
  }

  if (text.length < 40) {
    fs.rmSync(target, { force: true });
    throw new Error(
      isPdf(sourcePath)
        ? 'No selectable text in that PDF — it looks like a scan. Paste the text instead.'
        : 'That file has almost no text in it.'
    );
  }

  return { path: target, name: path.basename(sourcePath), chars: text.length };
}

function removeDocument(kind) {
  const dir = contextDir();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${kind}.`)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* the folder may not exist yet */
  }
  for (const file of [...cache.keys()]) {
    if (path.dirname(file) === dir) cache.delete(file);
  }
}

module.exports = { loadText, importDocument, removeDocument, contextDir, MAX_CHARS };
