import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { WsTerminalBridge } from './vendor/bridge.ts';
import { resolveShell, detectShells } from './vendor/shell.ts';

const assets = fileURLToPath(new URL('../../assets/', import.meta.url));
const prefix = '/__dsh-terminal/assets/';

export function mountTerminal({ webServer, spawnTerminal, resolveTarget }) {
  const active = new Set(), starting = new Set(), disposers = [];
  let closed = false;
  const bridge = new WsTerminalBridge({
    resolveShell, listShells: detectShells, resolveTarget,
    spawnTerminal(spec) {
      if (closed) return Promise.reject(new Error('Terminal contribution is closed'));
      const pending = (async () => {
        const handle = await spawnTerminal(spec);
        if (closed) { await handle.terminate(); throw new Error('Terminal contribution closed during spawn'); }
        active.add(handle);
        handle.done.then(() => active.delete(handle), () => active.delete(handle));
        return handle;
      })();
      starting.add(pending);
      pending.then(() => starting.delete(pending), () => starting.delete(pending));
      return pending;
    },
  });
  async function dispose() {
    if (closed) return;
    closed = true;
    for (const unregister of disposers.splice(0).reverse()) unregister();
    bridge.dispose();
    await Promise.allSettled([...starting]);
    const results = await Promise.allSettled([...active].map(handle => handle.terminate()));
    active.clear();
    const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
    if (errors.length) throw new AggregateError(errors, 'Terminal cleanup failed');
  }
  try {
    disposers.push(webServer.registerUpgrade({ path: '/__dsh-terminal/ws', handler: (req, socket, head) => {
      if (closed) { socket.destroy(); return; }
      bridge.handleUpgrade(req, socket, head);
    } }));
    disposers.push(webServer.register({ kind: 'exact', path: '/__dsh-terminal/shells', handler(req, res) {
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ shells: detectShells() }));
    } }));
    disposers.push(webServer.register({ kind: 'prefix', path: '/__dsh-terminal/assets', async handler(req, res) {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = resolve(assets, pathname.slice(prefix.length));
        if (!pathname.startsWith(prefix) || !file.startsWith(assets) || pathname.includes('\0')) throw new Error('Invalid asset');
        const info = await stat(file);
        if (!info.isFile()) throw new Error('Not a file');
        res.writeHead(200, { 'Content-Type': extname(file) === '.otf' ? 'font/otf' : 'application/octet-stream', 'Content-Length': info.size });
        createReadStream(file).on('error', () => res.destroy()).pipe(res);
      } catch { res.writeHead(404); res.end(); }
    } }));
  } catch (error) { void dispose(); throw error; }
  return dispose;
}
