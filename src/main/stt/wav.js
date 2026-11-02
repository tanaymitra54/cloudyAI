'use strict';

const fs = require('fs');

// Minimal 16-bit mono PCM WAV writer. whisper.cpp's CLI wants a file, not a pipe.
function writeWav(filePath, int16, sampleRate = 16000) {
  const dataSize = int16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(int16.buffer, int16.byteOffset, dataSize).copy(buf, 44);
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

function concatInt16(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function tail(chunks, maxSamples) {
  const all = concatInt16(chunks);
  return all.length <= maxSamples ? all : all.subarray(all.length - maxSamples);
}

module.exports = { writeWav, concatInt16, tail };
