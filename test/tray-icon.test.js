'use strict';

const assert = require('assert');
const { trayTigerBitmap } = require('../src/main/tray-icon');

function alphaAt(buf, size, x, y) {
  return buf[(y * size + x) * 4 + 3];
}

const size = 22;
const buf = trayTigerBitmap(size);
assert.strictEqual(buf.length, size * size * 4, 'RGBA buffer size');

// Corners stay clear so the template reads as a mark, not a filled square.
assert.strictEqual(alphaAt(buf, size, 0, 0), 0, 'top-left corner transparent');
assert.strictEqual(alphaAt(buf, size, size - 1, 0), 0, 'top-right corner transparent');
assert.strictEqual(alphaAt(buf, size, 0, size - 1), 0, 'bottom-left corner transparent');

// Head body + ears should be opaque (tiger silhouette, not a hollow ring).
assert.ok(alphaAt(buf, size, 11, 12) > 200, 'head center filled');
assert.ok(alphaAt(buf, size, 6, 4) > 200, 'left ear filled');
assert.ok(alphaAt(buf, size, 15, 4) > 200, 'right ear filled');

// Hollow ring would leave a gap between ear and center; silhouette should not.
assert.ok(alphaAt(buf, size, 11, 7) > 200, 'forehead filled (not ring gap)');

console.log('tray-icon: ok');
