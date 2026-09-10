import test from 'node:test';
import assert from 'node:assert/strict';
import { resizable } from '../../terminal-dsh-bridge/index.mjs';

test('private PTY resize forwards dimensions on every platform and stops after exit', async () => {
  let finish;
  const calls = [];
  const handle = { pid: 123, done: new Promise(resolve => { finish = resolve; }),
    terminal: { resize: (...size) => calls.push(size) }, write() {}, terminate() {} };
  const adapted = await resizable(handle);
  adapted.resize(103, 37);
  assert.deepEqual(calls, [[103, 37]]);
  assert.throws(() => adapted.resize(0, 37), /Invalid terminal dimensions/);
  finish();
  await handle.done;
  adapted.resize(80, 24);
  assert.equal(calls.length, 1);
});
