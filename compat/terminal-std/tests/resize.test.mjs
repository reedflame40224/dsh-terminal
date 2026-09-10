import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResizeController } from '../../terminal-dsh-bridge/resize-controller.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  let size = { cols: 80, rows: 24 };
  const events = [];
  const term = { ...size, resize(cols, rows) { events.push(['xterm', cols, rows]); Object.assign(this, { cols, rows }); } };
  const controller = createResizeController({ term, propose: () => size, ready: () => true, send: (cols, rows) => events.push(['pty', cols, rows]), delay: 5, narrowDelay: 5 });
  return { controller, term, events, propose: next => size = next };
}
test('drag commits only the final geometry to xterm and PTY together', async () => {
  const f = fixture();
  f.controller.begin();
  for (const cols of [120, 55, 100]) { f.propose({ cols, rows: 24 }); f.controller.fit(); }
  await sleep(15);
  assert.deepEqual(f.events, []);
  f.controller.end();
  assert.deepEqual(f.events, [['xterm', 100, 24], ['pty', 100, 24]]);
  f.controller.dispose();
});
test('release synchronizes PTY even if xterm already has the final dimensions', () => {
  const f = fixture();
  f.controller.begin(); f.controller.end();
  assert.deepEqual(f.events, [['pty', 80, 24]]);
  f.controller.dispose();
});
test('window resize coalesces and disposal cancels deferred work', async () => {
  const f = fixture();
  f.propose({ cols: 100, rows: 30 }); f.controller.fit();
  f.propose({ cols: 60, rows: 20 }); f.controller.fit();
  await sleep(25);
  assert.deepEqual(f.events, [['pty', 60, 20], ['xterm', 60, 20]]);
  f.controller.fit(); f.controller.dispose();
  await sleep(15);
  assert.equal(f.events.length, 2);
});
test('a stale shrink cannot resize after a newer width or disposal', async () => {
  const f = fixture();
  f.propose({ cols: 40, rows: 24 }); f.controller.fit(true);
  assert.equal(f.term.cols, 80);
  f.propose({ cols: 100, rows: 24 }); f.controller.fit(true);
  await sleep(15);
  assert.equal(f.term.cols, 100);
  f.propose({ cols: 50, rows: 24 }); f.controller.fit(true);
  f.controller.dispose();
  await sleep(15);
  assert.equal(f.term.cols, 100);
});
