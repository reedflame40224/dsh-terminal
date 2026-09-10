import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const { bindContributionHost } = await import('@dsh-std/ui');
const { default: facet, surface } = await import('../host.mjs');
const { mountTerminal } = await import('../terminal.mjs');

function routes() {
  const registered = new Map();
  const register = row => { assert.ok(!registered.has(row.path)); registered.set(row.path, row); return () => registered.delete(row.path); };
  return { registered, webServer: { register, registerUpgrade: register } };
}

test('requires negotiated UI capability and rolls back partially registered routes', () => {
  assert.throws(() => facet.activate({ protocols: { client: () => undefined } }), /not negotiated/);
  const state = routes();
  const webServer = { ...state.webServer, register() { throw new Error('route collision'); } };
  assert.throws(() => mountTerminal({ webServer, spawnTerminal() {} }), /route collision/);
  assert.equal(state.registered.size, 0);
});

test('standard ContributionHost owns route leases and permits clean remount', async () => {
  const state = routes();
  const provider = { participantId: 'terminal-provider', support: { surfaces: [{ ...surface, modes: ['local-module'] }] },
    register(_owner, contribution) { return contribution.localModule.mount({ webServer: state.webServer, spawnTerminal() {} }); } };
  const owner = { component: 'local.terminal-std', version: '0.1.0-lab.1', facet: 'host', instanceId: 'test-instance', participantId: 'test-consumer' };
  const agreement = { surfaces: [{ ...surface, consumer: owner.participantId, provider: provider.participantId, mode: 'local-module' }] };
  for (let i = 0; i < 2; i++) {
    const binding = bindContributionHost(agreement, owner, provider);
    facet.activate({ protocols: { client: () => binding.client } });
    assert.equal(state.registered.size, 3);
    await binding.close();
    assert.equal(state.registered.size, 0);
    assert.throws(() => facet.activate({ protocols: { client: () => binding.client } }), /closed/);
  }
});

test('unload waits for a pending PTY spawn and its termination', async () => {
  const state = routes();
  let resolveSpawn, entered, terminated = false;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { resolveSpawn = resolve; });
  const dispose = mountTerminal({ webServer: state.webServer, spawnTerminal() { entered(); return pending; } });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => state.registered.get('/__dsh-terminal/ws').handler(req, socket, head));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/__dsh-terminal/ws`);
  ws.on('error', () => {});
  try {
    await new Promise(resolve => ws.once('open', resolve));
    ws.send(JSON.stringify({ t: 'spawn' }));
    await enteredPromise;
    let closed = false;
    const closing = dispose().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    resolveSpawn({ pid: 1, output: new PassThrough(), done: Promise.resolve({ exitCode: 0, signal: null }),
      async terminate() { await new Promise(resolve => setTimeout(resolve, 20)); terminated = true; } });
    await closing;
    assert.equal(terminated, true);
    assert.equal(state.registered.size, 0);
  } finally {
    ws.terminate();
    await dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
