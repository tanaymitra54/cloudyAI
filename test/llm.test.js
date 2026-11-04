'use strict';

// Offline tests for the LLM layer: SSE streaming against a local mock server,
// abort behaviour, and the opencode JSON-lines parser.

const http = require('http');
const assert = require('assert');
const deepseek = require('../src/main/llm/deepseek');
const { parseOpencodeJson } = require('../src/main/llm/cli');

function sseServer(parts, { delayMs = 0 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        server.bodies.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const p of parts) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.bodies = [];
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function testStreaming() {
  const server = await sseServer(['**Answer:** ', 'a hash map is ', '`O(1)` lookup.']);
  const port = server.address().port;
  const deltas = [];
  const { text } = await deepseek.complete({
    cfg: { apiKey: 'test', baseUrl: `http://127.0.0.1:${port}`, model: 'deepseek-chat' },
    system: 'sys',
    user: 'what is a hash map?',
    onDelta: (d) => deltas.push(d),
  });
  server.close();

  assert.strictEqual(text, '**Answer:** a hash map is `O(1)` lookup.');
  assert.strictEqual(deltas.length, 3);
  assert.strictEqual(deltas.join(''), text);
  console.log('ok   streaming SSE + delta callback');
}

async function testAbort() {
  const server = await sseServer(['one', 'two', 'three'], { delayMs: 120 });
  const port = server.address().port;
  const controller = new AbortController();

  const p = deepseek.complete({
    cfg: { apiKey: 'test', baseUrl: `http://127.0.0.1:${port}`, model: 'deepseek-chat' },
    system: 's',
    user: 'u',
    signal: controller.signal,
    onDelta: () => controller.abort(),
  });

  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = err.name === 'AbortError';
  }
  server.close();
  assert.ok(threw, 'abort should surface as AbortError');
  console.log('ok   abort cancels an in-flight stream');
}

function testMissingKey() {
  return deepseek
    .complete({ cfg: { apiKey: '' }, system: 's', user: 'u' })
    .then(() => assert.fail('should have thrown'))
    .catch((err) => {
      assert.match(err.message, /No API key for DeepSeek/);
      console.log('ok   missing key gives an actionable error');
    });
}

async function testImageContent() {
  const server = await sseServer(['ok']);
  const port = server.address().port;
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  await deepseek.complete({
    cfg: { apiKey: 'test', baseUrl: `http://127.0.0.1:${port}`, model: 'deepseek-chat' },
    system: 'sys',
    user: 'what is on screen?',
    images: [dataUrl],
  });
  server.close();

  const body = JSON.parse(server.bodies[0]);
  const user = body.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user.content), 'user content should be a multi-part array');
  assert.strictEqual(user.content[0].type, 'text');
  assert.strictEqual(user.content[0].text, 'what is on screen?');
  assert.deepStrictEqual(user.content[1], { type: 'image_url', image_url: { url: dataUrl } });
  console.log('ok   screenshots become image_url content parts');
}

function testOpencodeParser() {
  const raw = [
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Binary search ' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'halves the range.' } }),
  ].join('\n');
  assert.strictEqual(parseOpencodeJson(raw), 'Binary search halves the range.');
  console.log('ok   opencode JSON-lines parser');
}

(async () => {
  await testStreaming();
  await testAbort();
  await testMissingKey();
  await testImageContent();
  testOpencodeParser();
  console.log('\nall llm tests passed');
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
