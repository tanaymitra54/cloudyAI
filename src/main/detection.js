'use strict';

// Question detection for live interview audio.
//
// The problem this solves: a copilot hears both sides of the call. A naive
// "does it contain what/how/why" check fires on the candidate's own answers,
// which is worse than staying silent. These signals are cheap (microseconds),
// so detection adds no latency to the answer path.

const INTERROGATIVE =
  /^(what|why|how|when|where|which|who|whose|whom|can|could|would|should|will|do|does|did|is|are|was|were|have|has|tell me|walk me|talk me|describe|explain|design|implement|write|solve|given|suppose|imagine)\b/i;

const IMPERATIVE =
  /\b(tell me|walk me through|talk me through|describe|explain|design|implement|write|solve|optimi[sz]e|debug|refactor|compare|difference between|what happens|how would you|why would you|what would you)\b/i;

// First-person narrative is the strongest signal that the candidate is talking.
// Only pronouns and first-person verbs belong here: discourse markers like
// "so", "yeah" and "okay" open questions just as often, and treating them as
// narration is what used to swallow "So what is polymorphism?".
const NARRATIVE =
  /^(i|we|my|our|me)\b|\bi (worked|built|led|used|think|believe|handled|implemented|migrated|wrote)\b|\b(at|in) my (previous|last|current)\b|\bin my (experience|role|project)\b/i;

// Filler that survives transcription and carries no signal either way. These
// stack in real speech ("right, so, um, okay so…"), so the stripper loops
// instead of peeling one off.
const FILLER =
  /^(okay|ok|so|now|right|alright|great|thanks|thank you|cool|well|and|but|mm|hmm|um|uh|er|ah|like|yeah|yes|you know)\b[,\s]*/i;

/**
 * Drop every leading filler word. Returns '' when the line was nothing but
 * filler, which callers treat as "nothing was said". Punctuation left behind
 * by stripping ("Yeah." -> ".") does not count as speech.
 */
function stripFiller(text) {
  let out = String(text || '').trim();
  for (let i = 0; i < 8; i++) {
    const next = out.replace(FILLER, '').trim();
    if (next === out) break;
    out = next;
  }
  return /[a-z0-9]/i.test(out) ? out : '';
}

// "What I did was..." / "How we solved it..." look interrogative by their first
// word but are the candidate narrating. This is the most common false positive.
const CANDIDATE_PHRASE = /\b(what|how|why|when|where) (i|we|my|our|the team)\b|\b(i|we) (then|also|basically|actually|ended up)\b/i;

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * @returns {{score: number, isQuestion: boolean, speculativeSafe: boolean, words: number, reason: string}}
 */
function scoreQuestion(text) {
  const raw = (text || '').trim();
  if (!raw)
    return { score: 0, isQuestion: false, speculativeSafe: false, words: 0, reason: 'empty' };

  const t = stripFiller(raw);
  if (!t)
    return { score: 0, isQuestion: false, speculativeSafe: false, words: 0, reason: 'filler-only' };
  let score = 0;
  const reasons = [];

  if (t.endsWith('?')) {
    score += 3;
    reasons.push('question-mark');
  }
  if (INTERROGATIVE.test(t)) {
    score += 2;
    reasons.push('interrogative-opener');
  }
  if (IMPERATIVE.test(t)) {
    score += 2;
    reasons.push('ask-to-explain');
  }
  if (NARRATIVE.test(t)) {
    score -= 3;
    reasons.push('first-person');
  }
  if (CANDIDATE_PHRASE.test(t)) {
    score -= 3;
    reasons.push('candidate-phrasing');
  }

  const words = wordCount(t);
  if (words < 4) {
    score -= 2;
    reasons.push('too-short');
  }
  if (words >= 8) {
    score += 1;
    reasons.push('long-enough');
  }

  const hasMark = t.endsWith('?');

  return {
    score,
    isQuestion: score >= 2,
    words,
    // Answering from a live caption is only safe once the question has actually
    // ended. "Can you explain the difference between" scores as a question but
    // is a fragment; answering it produces a confidently wrong answer.
    speculativeSafe: hasMark && words >= 5,
    reason: reasons.join('+') || 'none',
  };
}

/** Token-overlap similarity, 0..1. Used to avoid answering the same question twice. */
function similarity(a, b) {
  const A = new Set(normalize(a || '').split(' ').filter(Boolean));
  const B = new Set(normalize(b || '').split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size);
}

module.exports = { scoreQuestion, similarity, normalize, wordCount, stripFiller };
