'use strict';

// Question-vs-narration detection tests, using phrasings that actually occur in
// interviews (interviewer questions and candidate answers).

const assert = require('assert');
const { scoreQuestion, similarity } = require('../src/main/detection');

const SHOULD_ASK = [
  'What is a closure in JavaScript?',
  'Can you explain how indexing works in Postgres?',
  'Tell me about a time you had a conflict with a teammate.',
  'Design a URL shortener that handles a million requests per second.',
  'How would you optimize this query?',
  'Walk me through your last project.',
  'Why did you choose Kafka over RabbitMQ?',
  'What happens when you type a URL into the browser?',
  'So, what is polymorphism?',
  'Describe a situation where you disagreed with your manager.',
];

const SHOULD_NOT_ASK = [
  'I worked at a startup where we built a payment system.',
  'So my team led the migration to Kubernetes.',
  'Yeah.',
  'Okay.',
  'We used Redis for caching and it worked well.',
  'In my previous role I implemented a CI/CD pipeline.',
  'I think the main difference is performance.',
  'What I did was create a new service for billing.',
  'How we solved it was adding a queue in front of the database.',
  'Thank you.',
  //
  // Short fragments produced mid-utterance by the live caption.
  //
  'the',
  'what is',
];

let failures = 0;

for (const s of SHOULD_ASK) {
  const v = scoreQuestion(s);
  const ok = v.isQuestion;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ASK     score=${String(v.score).padStart(2)} [${v.reason}] ${s}`);
}

for (const s of SHOULD_NOT_ASK) {
  const v = scoreQuestion(s);
  const ok = !v.isQuestion;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} SILENT  score=${String(v.score).padStart(2)} [${v.reason}] ${s}`);
}

// Dedupe: a partial and its final must be recognised as the same question.
const partial = 'Can you explain how indexing';
const final = 'Can you explain how indexing works in Postgres?';
assert.ok(similarity(partial, final) > 0.5, 'partial and final should be similar');

// Growth detection: a question that keeps growing is a different question.
const grown = 'Can you explain how indexing works in Postgres and when would you avoid it?';
assert.ok(similarity(final, grown) > 0.5, 'grown question still overlaps');
assert.ok(
  grown.split(/\s+/).length > final.split(/\s+/).length * 1.15,
  'grown question must be detected as longer'
);

console.log(`\n${failures === 0 ? 'all detection cases passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
