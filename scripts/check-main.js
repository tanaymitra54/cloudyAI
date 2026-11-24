'use strict';

// Load-check every main-process module without electron, so a typo in a
// `module.exports` block or a top-level crash fails CI instead of shipping an
// installer that dies with "A JavaScript error occurred in the main process".
//
// This is not a test of behaviour: it only proves each module can be required
// and that every name it exports actually exists.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}
walk(path.join(ROOT, 'src', 'main'));

let problems = 0;

// 1. Every name in `module.exports = { ... }` must be declared in that file.
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const block = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!block) continue;
  // The export list itself would match every name, so remove it first.
  const body = source.replace(block[0], '');
  for (const raw of block[1].split(',')) {
    const name = raw.trim().split(':')[0].trim();
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const declared = new RegExp(
      `(^|\\n)\\s*(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b|(^|\\n)\\s*${name}\\s*[,=]`,
      'm'
    ).test(body);
    if (!declared) {
      problems++;
      console.log(`FAIL ${path.relative(ROOT, file)}: exports "${name}" but never declares it`);
    }
  }
}

// 2. Each module must be requireable. `electron` is stubbed because the real
//    module is only available inside an Electron process.
const electronStub = new Proxy(
  {},
  {
    get: () =>
      new Proxy(function stub() {}, {
        get: () => () => '',
        apply: () => '',
      }),
  }
);
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return realLoad.apply(this, arguments);
};

for (const file of files) {
  try {
    require(file);
  } catch (err) {
    problems++;
    console.log(`FAIL ${path.relative(ROOT, file)}: cannot be required — ${err.message}`);
  }
}

if (problems) {
  console.log(`\n${problems} problem(s) in the main process`);
  process.exit(1);
}
console.log(`main process loads cleanly (${files.length} modules)`);
