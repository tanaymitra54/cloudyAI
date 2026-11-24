'use strict';

// Download a whisper.cpp GGML model. Cross-platform replacement for
// get-model.sh so the same command works on macOS, Linux and Windows.
//
//   npm run get-model                 -> ggml-base.en.bin (~142 MB) into ~/.cache/cloudyvoice
//   npm run get-model -- small        -> ggml-small.en.bin (~466 MB)
//   npm run get-model -- tiny         -> ggml-tiny.en.bin (~75 MB)
//   node scripts/get-model.js base --out vendor/models   -> wherever packaging needs it

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const positional = [];
let outDir = path.join(os.homedir(), '.cache', 'cloudyvoice');
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--out' || arg === '-o') {
    outDir = args[++i] || outDir;
    continue;
  }
  if (arg.startsWith('-')) continue;
  positional.push(arg);
}
outDir = path.resolve(outDir);
const sizeArg = positional[0] || 'base';
const file = `ggml-${String(sizeArg).replace(/\.en$/, '')}.en.bin`;
const dest = path.join(outDir, file);
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

function download(target, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(target, { headers: { 'User-Agent': 'CloudyAI-model-fetch' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          return resolve(download(res.headers.location, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${target}`));
        }

        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        let lastPrint = 0;
        const tmp = `${dest}.part`;
        const out = fs.createWriteStream(tmp);

        res.on('data', (chunk) => {
          received += chunk.length;
          if (total && Date.now() - lastPrint > 500) {
            lastPrint = Date.now();
            const percent = ((received / total) * 100).toFixed(1);
            process.stdout.write(`\r  ${percent}%  ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            process.stdout.write('\n');
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
        out.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(dest)) {
    console.log(`CloudyVoice model already present: ${dest}`);
    return;
  }
  console.log(`Downloading ${file} -> ${dest}`);
  try {
    await download(url);
    console.log(`Done: ${dest}`);
  } catch (err) {
    fs.rm(`${dest}.part`, { force: true }, () => {});
    console.error(`Download failed: ${err.message}`);
    console.error(`Download it manually from ${url}`);
    process.exitCode = 1;
  }
})();
