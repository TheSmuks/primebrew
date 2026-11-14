const assert = require('assert');
const { pickNext } = require('./userScript.js');

const box = (left, top) => ({ left, top, width: 100, height: 50 });
const from = box(500, 500);
const rects = [
  box(700, 500), // 0: right, same row
  box(500, 700), // 1: below
  box(300, 500), // 2: left
  box(500, 300), // 3: above
  box(650, 900), // 4: far below-right (should lose to 1 for down)
  box(620, 420), // 5: right but off-row (should lose to 0 for right)
];

assert.strictEqual(pickNext(from, rects, 'right'), 0);
assert.strictEqual(pickNext(from, rects, 'down'), 1);
assert.strictEqual(pickNext(from, rects, 'left'), 2);
assert.strictEqual(pickNext(from, rects, 'up'), 3);
assert.strictEqual(pickNext(from, [box(100, 100)], 'right'), -1); // nothing that way
// The on-screen badge must show the released version.
const src = require('fs').readFileSync(__dirname + '/userScript.js', 'utf8');
assert.ok(src.includes(`var VERSION = '${require('./package.json').version}'`), 'VERSION out of sync with package.json');
console.log('ok');
