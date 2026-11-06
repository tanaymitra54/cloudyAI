'use strict';

// Overlay rendering: answers are read at a glance during a live call, so a
// coding answer has to arrive as one properly framed, coloured C++ block rather
// than a wall of plain text or a half-rendered fence while it streams.

const assert = require('assert');
const { render, highlightCpp } = require('../src/renderer/overlay/render');

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

const sample = [
  '**Idea:** sliding window, O(n).',
  '',
  '```cpp',
  '#include <bits/stdc++.h>',
  'using namespace std;',
  '',
  '// keep the window valid',
  'class Solution {',
  'public:',
  '  int lengthOfLongestSubstring(string s) {',
  '    int best = 0;',
  '    return best;',
  '  }',
  '};',
  '```',
].join('\n');

check('a cpp fence becomes one framed code block', () => {
  const html = render(sample);
  assert.strictEqual((html.match(/class="code"/g) || []).length, 1);
  assert.match(html, /class="code-head">C\+\+</);
  assert.match(html, /<pre><code class="cpp">/);
  assert.doesNotMatch(html, /```/);
});

check('keywords, types, functions, comments and numbers are coloured', () => {
  const html = render(sample);
  assert.match(html, /<span class="tok-pre">#include<\/span>/);
  assert.match(html, /<span class="tok-kw">class<\/span>/);
  assert.match(html, /<span class="tok-kw">return<\/span>/);
  assert.match(html, /<span class="tok-type">int<\/span>/);
  assert.match(html, /<span class="tok-type">string<\/span>/);
  assert.match(html, /<span class="tok-fn">lengthOfLongestSubstring<\/span>/);
  assert.match(html, /<span class="tok-com">\/\/ keep the window valid<\/span>/);
  assert.match(html, /<span class="tok-num">0<\/span>/);
});

check('code is escaped, never injected as HTML', () => {
  const html = highlightCpp('vector<int> v = {1 < 2}; if (v.size() && a) {}');
  assert.doesNotMatch(html, /<int>/);
  assert.match(html, /&lt;/);
  assert.match(html, /&gt;/);
  assert.match(html, /&amp;&amp;/);
});

check('a block still streaming (no closing fence) is rendered, not dropped', () => {
  const html = render(['```cpp', 'int main() {', '  return 0;'].join('\n'));
  assert.match(html, /class="code"/);
  assert.match(html, /<span class="tok-kw">return<\/span>/);
});

check('an untagged fence that is clearly C++ still gets C++ colours', () => {
  const html = render(['```', '#include <vector>', 'int main() {}', '```'].join('\n'));
  assert.match(html, /class="code-head">C\+\+</);
});

check('a non-code fence keeps its label and is not C++ coloured', () => {
  const html = render(['```text', 'just words', '```'].join('\n'));
  assert.match(html, /class="code-head">TEXT</);
  assert.doesNotMatch(html, /tok-kw/);
});

check('prose, bullets and inline code still render', () => {
  const html = render('**A** and `x`\n\n- one\n- two');
  assert.match(html, /<strong>A<\/strong>/);
  assert.match(html, /<code>x<\/code>/);
  assert.strictEqual((html.match(/<li>/g) || []).length, 2);
});

// The transcript panel used to throw ReferenceError on every line, because the
// renderer pulled only `render` out of CloudyRender and then called escapeHtml.
// This check fails if the two drift apart again.
check('overlay pulls every renderer helper it calls', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/overlay/overlay.js'), 'utf8');
  const destructure = src.match(/const\s*\{([^}]*)\}\s*=\s*window\.CloudyRender/);
  assert.ok(destructure, 'overlay must destructure window.CloudyRender');
  const pulled = destructure[1].split(',').map((s) => s.trim()).filter(Boolean);
  const exported = Object.keys(require('../src/renderer/overlay/render'));
  for (const helper of exported) {
    const called = new RegExp(`\\b${helper}\\s*\\(`).test(src);
    if (called) assert.ok(pulled.includes(helper), `overlay calls ${helper}() but does not destructure it`);
  }
  assert.ok(pulled.includes('escapeHtml'), 'transcript rendering needs escapeHtml');
});

console.log(`\n${failures === 0 ? `all ${total} overlay render cases passed` : `${failures}/${total} FAILED`}`);
process.exit(failures ? 1 : 0);
