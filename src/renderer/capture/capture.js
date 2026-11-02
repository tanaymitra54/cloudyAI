'use strict';

// 16 kHz mono Int16 PCM capture.
//
// A microphone stream is resampled in an AudioWorklet (off the main thread) and
// posted to the preload bridge in 100 ms chunks. 100 ms keeps TanayVoice's VAD
// responsive without flooding IPC.

const TARGET_RATE = 16000;

let ctx = null;
let node = null;
let stream = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestStream() {
  const constraints = {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
  };

  let lastError;
  // AbortError is Chromium cancelling a pending request — a dismissed prompt, or
  // a request superseded by another one. It is transient, so retry once before
  // telling the user the microphone is unavailable.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
      if (err.name !== 'AbortError') break;
      await sleep(800);
    }
  }
  throw lastError;
}

async function start() {
  if (stream) return { ok: true, already: true };

  console.log('[capture] start requested');
  try {
    stream = await requestStream();
    const track = stream.getAudioTracks()[0];
    console.log('[capture] stream acquired:', track ? track.label : '(no track)', track ? track.readyState : '');

    ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume();

    await ctx.audioWorklet.addModule('pcm-worklet.js');
    console.log('[capture] worklet ready @', ctx.sampleRate, 'Hz');

    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (event) => window.tanay.capture.send(event.data);
    source.connect(node);
    console.log('[capture] capture live');

    return { ok: true, rate: ctx.sampleRate };
  } catch (err) {
    // Never leave the microphone held open after a failed start.
    stop();
    console.log('[capture] error:', err.name, '-', err.message);
    const message =
      err.name === 'NotAllowedError'
        ? 'Permission denied. Enable TanayAI in System Settings → Privacy & Security → Microphone.'
        : `${err.name}: ${err.message || err}`;
    throw new Error(message);
  }
}

function stop() {
  try {
    node?.port.close();
    node?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
  } catch {
    /* teardown */
  }
  node = null;
  stream = null;
  ctx = null;
}

const stateEl = document.getElementById('state');
window.__capLog = [];
const log = (...args) => {
  window.__capLog.push(args.join(' '));
  console.log(...args);
};

window.onerror = (message, source, line) => log('[capture] window error:', message, source, line);
window.addEventListener('unhandledrejection', (e) => log('[capture] unhandled rejection:', e.reason && e.reason.message));

log('[capture] renderer ready; bridge =', typeof window.tanay, '; onCommand =', window.tanay ? typeof window.tanay.onCommand : 'missing');

window.tanay.onCommand(async (cmd) => {
  log('[capture] command:', cmd);
  try {
    if (cmd === 'start') {
      const res = await start();
      stateEl.textContent = `capturing @ ${res.rate || TARGET_RATE} Hz`;
      log('[capture] started:', JSON.stringify(res));
    } else {
      stop();
      stateEl.textContent = 'microphone idle';
      log('[capture] stopped');
    }
  } catch (err) {
    stateEl.textContent = `microphone error: ${err.message}`;
    log('[capture] failed:', err.message);
    window.tanay.capture.fail(err.message);
  }
});

// A hidden window still needs one render before the worklet can attach.
stateEl.textContent = 'microphone idle';
