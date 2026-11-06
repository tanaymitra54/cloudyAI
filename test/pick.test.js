'use strict';

// Picker tests for ⌘J: newest question wins, including during the gap between
// the live partial clearing and the final landing in `turns`.

const assert = require('assert');
const { pickQuestion, shouldSkipAnswer, conversationFor } = require('../src/main/pick');

const now = Date.now();
const Q1 = 'What is a closure in JavaScript?';
const Q2 = 'How would you design a rate limiter?';

let failures = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

// --- In-flight text wins -------------------------------------------------

check('finalize gap: pending Q2 beats committed Q1', () => {
  const picked = pickQuestion({
    turns: [{ text: Q1, at: now - 3000, utteranceId: 'u1' }],
    pendingText: Q2,
    speaking: false,
    now,
  });
  assert.ok(picked, 'expected a pick');
  assert.strictEqual(picked.text, Q2);
  assert.strictEqual(picked.source, 'pending');
});

check('still speaking: partial Q2 is not glued onto Q1', () => {
  const picked = pickQuestion({
    turns: [{ text: Q1, at: now - 3000, utteranceId: 'u1' }],
    partial: Q2,
    speaking: true,
    now,
  });
  assert.ok(picked, 'expected a pick');
  assert.strictEqual(picked.text, Q2);
  assert.strictEqual(picked.source, 'partial');
  assert.ok(!picked.text.includes(Q1), 'must not contain the older question');
});

check('pending wins over partial when both are present', () => {
  const picked = pickQuestion({
    pendingText: Q2,
    partial: 'how would you design',
    speaking: true,
    now,
  });
  assert.strictEqual(picked.text, Q2);
  assert.strictEqual(picked.source, 'pending');
});

// --- Age cap and no walking back ----------------------------------------

check('old question is excluded by the age cap', () => {
  const picked = pickQuestion({
    turns: [
      { text: Q1, at: now - 120000, utteranceId: 'u1' },
      { text: 'I worked at a startup where we built payments.', at: now - 5000, utteranceId: 'u2' },
    ],
    now,
  });
  assert.ok(picked, 'expected the recent turn');
  assert.notStrictEqual(picked.text, Q1);
  assert.strictEqual(picked.utteranceId, 'u2');
});

check('every turn too old returns null', () => {
  const picked = pickQuestion({
    turns: [{ text: Q1, at: now - 120000, utteranceId: 'u1' }],
    now,
  });
  assert.strictEqual(picked, null);
});

check('short question is still the subject', () => {
  const picked = pickQuestion({
    turns: [{ text: 'Why?', at: now - 1000, utteranceId: 'u1' }],
    now,
  });
  assert.ok(picked);
  assert.strictEqual(picked.text, 'Why?');
  assert.strictEqual(picked.source, 'turn');
});

check('narration after a question is the newest subject', () => {
  const narration = 'I worked at a startup where we built a payment system.';
  const picked = pickQuestion({
    turns: [
      { text: Q1, at: now - 6000, utteranceId: 'u1' },
      { text: narration, at: now - 2000, utteranceId: 'u2' },
    ],
    now,
  });
  assert.ok(picked);
  assert.strictEqual(picked.text, narration);
  assert.strictEqual(picked.utteranceId, 'u2');
});

// --- Fragment merging ---------------------------------------------------

check('split question fragments merge', () => {
  const picked = pickQuestion({
    turns: [
      { text: 'Can you walk me through', at: now - 1500, utteranceId: 'u1' },
      { text: 'how you would design a rate limiter?', at: now, utteranceId: 'u2' },
    ],
    now,
  });
  assert.ok(picked);
  assert.strictEqual(picked.text, 'Can you walk me through how you would design a rate limiter?');
  assert.strictEqual(picked.utteranceId, 'u2');
});

check('no merge across a finished sentence', () => {
  const picked = pickQuestion({
    turns: [
      { text: 'Thanks.', at: now - 2000, utteranceId: 'u1' },
      { text: 'Can you explain indexes?', at: now - 1000, utteranceId: 'u2' },
    ],
    now,
  });
  assert.ok(picked);
  assert.strictEqual(picked.text, 'Can you explain indexes?');
});

check('no merge across a long gap', () => {
  const picked = pickQuestion({
    turns: [
      { text: 'Can you walk me through', at: now - 9000, utteranceId: 'u1' },
      { text: 'how you would design a rate limiter?', at: now, utteranceId: 'u2' },
    ],
    now,
  });
  assert.strictEqual(picked.text, 'how you would design a rate limiter?');
});

check('merge stops after three turns', () => {
  const picked = pickQuestion({
    turns: [
      { text: 'so', at: now - 3000, utteranceId: 'u1' },
      { text: 'can you tell me', at: now - 2000, utteranceId: 'u2' },
      { text: 'how indexes', at: now - 1000, utteranceId: 'u3' },
      { text: 'work in postgres?', at: now, utteranceId: 'u4' },
    ],
    now,
  });
  assert.strictEqual(picked.text, 'can you tell me how indexes work in postgres?');
});

// --- Hygiene ------------------------------------------------------------

check('empty and whitespace turns are ignored', () => {
  const picked = pickQuestion({
    turns: [
      { text: Q1, at: now - 3000, utteranceId: 'u1' },
      { text: '   ', at: now - 1000, utteranceId: 'u2' },
    ],
    now,
  });
  assert.strictEqual(picked.text, Q1);
  assert.strictEqual(picked.utteranceId, 'u1');
});

check('returned text is trimmed and capped at 2000 chars', () => {
  const long = `${'word '.repeat(600)}?`;
  const picked = pickQuestion({
    turns: [{ text: `  ${long}  `, at: now, utteranceId: 'u1' }],
    now,
  });
  assert.ok(picked.text.length <= 2000);
  assert.strictEqual(picked.text, picked.text.trim());
});

check('no input at all returns null', () => {
  assert.strictEqual(pickQuestion({}), null);
  assert.strictEqual(pickQuestion({ turns: [], partial: '', pendingText: '', now }), null);
});

check('single-word in-flight text is not enough', () => {
  const picked = pickQuestion({
    turns: [{ text: Q1, at: now - 1000, utteranceId: 'u1' }],
    partial: 'Why',
    speaking: true,
    now,
  });
  assert.strictEqual(picked.text, Q1);
  assert.strictEqual(picked.source, 'turn');
});

// --- Skip decision ------------------------------------------------------

const busySame = {
  engineBusy: true,
  lastAnswered: { text: Q1, at: now - 1000, utteranceId: 'u1' },
  picked: { text: Q1, at: now - 1000, utteranceId: 'u1' },
};

check('skip: same utterance while busy', () => {
  assert.strictEqual(shouldSkipAnswer(busySame), true);
});

check('skip: different utterance while busy', () => {
  assert.strictEqual(
    shouldSkipAnswer({ ...busySame, picked: { ...busySame.picked, utteranceId: 'u2' } }),
    false
  );
});

check('skip: not busy', () => {
  assert.strictEqual(shouldSkipAnswer({ ...busySame, engineBusy: false }), false);
});

check('skip: missing ids are never skipped', () => {
  assert.strictEqual(
    shouldSkipAnswer({ engineBusy: true, lastAnswered: { text: Q1 }, picked: { text: Q1 } }),
    false
  );
  assert.strictEqual(
    shouldSkipAnswer({ engineBusy: true, lastAnswered: null, picked: busySame.picked }),
    false
  );
  assert.strictEqual(
    shouldSkipAnswer({ engineBusy: true, lastAnswered: busySame.lastAnswered, picked: null }),
    false
  );
  assert.strictEqual(shouldSkipAnswer({}), false);
});

// --- Full conversation ---------------------------------------------------

check('conversation: every turn is kept, oldest first', () => {
  const conv = conversationFor(
    [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    'd'
  );
  assert.deepStrictEqual(conv, ['a', 'b', 'c']);
});

check('conversation: the trigger line is not repeated', () => {
  const conv = conversationFor([{ text: 'a' }, { text: 'b' }], 'b');
  assert.deepStrictEqual(conv, ['a']);
});

check('conversation: newest kept when the cap is hit', () => {
  const turns = [{ text: 'old'.repeat(50) }, { text: 'newest question here' }];
  const conv = conversationFor(turns, '', 30);
  assert.deepStrictEqual(conv, ['newest question here']);
});

check('conversation: empty input is safe', () => {
  assert.deepStrictEqual(conversationFor([], ''), []);
  assert.deepStrictEqual(conversationFor(undefined, undefined), []);
});

console.log(`\n${failures === 0 ? `all ${total} pick cases passed` : `${failures}/${total} FAILED`}`);
process.exit(failures ? 1 : 0);
