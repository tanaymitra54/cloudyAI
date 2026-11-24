'use strict';

// Desktop loopback capture — the Windows equivalent of the macOS
// ScreenCaptureKit helper.
//
// getDisplayMedia is granted in main by session.setDisplayMediaRequestHandler
// with { audio: 'loopback' }, so the returned stream carries the computer's own
// output (the other participant of a call) and never the microphone. Chromium
// provides the WASAPI loopback internally, so nothing has to be installed on the
// machine.
//
// The audio track is resampled to 16 kHz mono by the same AudioWorklet the
// microphone path uses, and posted in 100 ms chunks.

const TARGET_RATE = 16000;

let ctx = null;
let node = null;
let stream = null;

async function start() {
  if (stream) return { ok: true, already: true };

  // A screen video track is what the loopback audio hangs off. Keep it alive
  // (stopping it can end the audio stream too) but at 1 fps and never read it.
  const captured = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const audioTrack = captured.getAudioTracks()[0];
  if (!audioTrack) {
    captured.getTracks().forEach((t) => t.stop());
    throw new Error('No system audio track was returned. Microphone-only mode will be used.');
  }

  ctx = new AudioContext({ sampleRate: 48000 });
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
  node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (event) => window.tanaySystem.send(event.data);
  source.connect(node);

  stream = captured;
  return { ok: true, rate: ctx.sampleRate, label: audioTrack.label };
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
const log = (...args) => console.log('[system-audio]', ...args);

window.tanaySystem.onCommand(async (cmd) => {
  log('command:', cmd);
  try {
    if (cmd === 'start') {
      const res = await start();
      stateEl.textContent = `system audio @ ${res.rate || TARGET_RATE} Hz`;
      log('started:', JSON.stringify(res));
    } else {
      stop();
      stateEl.textContent = 'system audio idle';
      log('stopped');
    }
  } catch (err) {
    stop();
    stateEl.textContent = `system audio error: ${err.message}`;
    // Not fatal: startListening keeps the microphone leg running.
    window.tanaySystem.fail(err.message || String(err));
  }
});

stateEl.textContent = 'system audio idle';
