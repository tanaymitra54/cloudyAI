'use strict';

/**
 * 22×22 template-friendly tiger-head silhouette (black + alpha).
 * Ears + round head — readable in the macOS menu bar.
 */
function trayTigerBitmap(size = 22, rgb = [0, 0, 0]) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = size * 0.58;
  const headRx = size * 0.34;
  const headRy = size * 0.36;

  function inEllipse(x, y, ex, ey, rx, ry) {
    const dx = (x - ex) / rx;
    const dy = (y - ey) / ry;
    return dx * dx + dy * dy <= 1;
  }

  // Triangular ears pointing up (left / right).
  function inEar(x, y, tipX, baseY) {
    const baseL = tipX - size * 0.14;
    const baseR = tipX + size * 0.14;
    const tipY = size * 0.05;
    if (y < tipY || y > baseY) return false;
    const t = (y - tipY) / (baseY - tipY);
    const left = tipX + (baseL - tipX) * t;
    const right = tipX + (baseR - tipX) * t;
    return x >= left && x <= right;
  }

  const earBaseY = cy - headRy * 0.55;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const head = inEllipse(x, y, cx, cy, headRx, headRy);
      const leftEar = inEar(x, y, cx - headRx * 0.72, earBaseY);
      const rightEar = inEar(x, y, cx + headRx * 0.72, earBaseY);
      const a = head || leftEar || rightEar ? 255 : 0;
      const i = (y * size + x) * 4;
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
      buf[i + 3] = a;
    }
  }
  return buf;
}

module.exports = { trayTigerBitmap };
