'use strict';

// Which utterance should ⌘J answer?
//
// The failure this replaces: after an utterance closes, the live partial is
// cleared and the final has not landed in `turns` yet. For 200 ms – 1.5 s the
// only thing visible is an older question, so the picker walked backwards and
// answered the wrong one. It also glued the live partial onto that older
// question, producing "Q1 Q2" as if it were a single ask.
//
// Two rules fix it:
//   1. Text that is still in flight (pending final, or live partial) is the
//      subject on its own — never concatenated with a committed turn.
//   2. Otherwise the newest recent turn *is* the subject, even when it scores
//      below the question threshold or looks like narration. A filter here is
//      how the picker ended up answering a stale question.
//
// Merging is only for split fragments of the same sentence, and only backwards.

const { wordCount } = require('./detection');

const MAX_TEXT = 2000;
const MAX_MERGED_TURNS = 3;
const FRAGMENT_GAP_MS = 4000;
const FRAGMENT_MAX_CHARS = 400;

/** A turn is usable only when it has text and a numeric timestamp. */
function isUsableTurn(turn) {
  return (
    turn &&
    typeof turn.text === 'string' &&
    turn.text.trim() !== '' &&
    Number.isFinite(turn.at)
  );
}

function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
    .trim();
}

/** Terminal punctuation means the sentence is finished; the next turn is a new one. */
function endsCleanly(text) {
  return /[.?!]\s*$/.test(text);
}

/**
 * Newest in-flight text, if it is substantial enough to stand alone.
 * Returns null when there is nothing in flight (or only a fragment).
 */
function pickInFlight({ pendingText, partial, speaking, now }) {
  const pending = clean(pendingText);
  if (pending && wordCount(pending) >= 2) {
    return { text: pending, source: 'pending', utteranceId: null, at: now };
  }

  if (!speaking && !pending) return null;

  const live = clean(partial);
  if (live && wordCount(live) >= 2) {
    return { text: live, source: 'partial', utteranceId: null, at: now };
  }
  return null;
}

/**
 * Newest recent turn, with contiguous fragments of the same sentence merged on.
 * Never walks past a stale newest turn to find a better-scoring older one.
 */
function pickFromTurns({ turns, now, maxAgeMs }) {
  const recent = turns
    .filter(isUsableTurn)
    .map((t) => ({ text: t.text.trim(), at: t.at, utteranceId: t.utteranceId ?? null }))
    .sort((a, b) => a.at - b.at); // stable: equal timestamps keep input order

  if (!recent.length) return null;

  const anchor = recent[recent.length - 1];
  if (anchor.at < now - maxAgeMs) return null; // too old: nothing worth answering

  let start = recent.length - 1;
  let merged = 1;

  // Only backwards, only across a short gap, only into an unfinished sentence,
  // and only up to three utterances total.
  while (start > 0 && merged < MAX_MERGED_TURNS) {
    const prev = recent[start - 1];
    const current = recent[start];
    if (current.at - prev.at >= FRAGMENT_GAP_MS) break;
    if (prev.text.length >= FRAGMENT_MAX_CHARS) break;
    if (endsCleanly(prev.text)) break;
    start -= 1;
    merged += 1;
  }

  const text = clean(
    recent
      .slice(start)
      .map((t) => t.text)
      .join(' ')
  );

  return {
    text,
    source: 'turn',
    utteranceId: anchor.utteranceId,
    at: anchor.at,
  };
}

/**
 * The newest question ⌘J should answer.
 *
 * @param {object} opts
 * @param {Array<{text: string, at: number, utteranceId?: string}>} [opts.turns]
 * @param {string} [opts.partial]      live caption, not yet committed
 * @param {string} [opts.pendingText]  final transcript waiting to be committed
 * @param {boolean} [opts.speaking]    utterance currently open
 * @param {number} [opts.now]
 * @param {number} [opts.maxAgeMs]
 * @returns {{text: string, source: 'pending'|'partial'|'turn', utteranceId: string|null, at: number}|null}
 */
function pickQuestion({
  turns = [],
  partial = '',
  pendingText = '',
  speaking = false,
  now = Date.now(),
  maxAgeMs = 20000,
} = {}) {
  if (!Array.isArray(turns)) turns = [];

  const inFlight = pickInFlight({ pendingText, partial, speaking, now });
  if (inFlight) return inFlight;

  return pickFromTurns({ turns, now, maxAgeMs });
}

function isSetId(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * True only when a busy engine is already answering this exact utterance.
 *
 * This replaces the old silent similarity block, which could suppress a new
 * (but lexically similar) question. Identity of the utterance is the signal.
 *
 * @param {object} opts
 * @param {boolean} [opts.engineBusy]
 * @param {{text?: string, at?: number, utteranceId?: string}|null} [opts.lastAnswered]
 * @param {{text?: string, at?: number, utteranceId?: string}|null} [opts.picked]
 * @returns {boolean}
 */
function shouldSkipAnswer({ engineBusy, lastAnswered, picked } = {}) {
  if (engineBusy !== true) return false;

  const answeredId = lastAnswered && lastAnswered.utteranceId;
  const pickedId = picked && picked.utteranceId;

  if (!isSetId(answeredId) || !isSetId(pickedId)) return false;
  return answeredId === pickedId;
}

module.exports = {
  pickQuestion,
  shouldSkipAnswer,
  MAX_TEXT,
  MAX_MERGED_TURNS,
  FRAGMENT_GAP_MS,
};
