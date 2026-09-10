import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import facet, { surface } from '../terminal-std/host.mjs';

export const name = 'dsh-terminal-std-bridge';
export const inject = ['dshStd', 'webServer', 'subprocess', 'connection'];
const run = promisify(execFile);

export function terminalSpec(spec) {
  if (process.platform !== 'linux') return spec;
  // alpha.2's node-pty name="dumb" overrides env.TERM before exec.
  return { ...spec, argv: ['/usr/bin/env', 'TERM=xterm-256color', ...spec.argv] };
}

// alpha.2 has no resize method. Linux stty applies TIOCSWINSZ to the existing PTY.
export async function resizable(handle) {
  if (typeof handle.resize === 'function' || process.platform !== 'linux') return handle;
  let exited = false;
  handle.done.then(() => { exited = true; }, () => { exited = true; });
  if (typeof handle.terminal?.resize === 'function') {
    return { pid: handle.pid, output: handle.output, done: handle.done,
      write: data => handle.write(data), terminate: () => handle.terminate(),
      resize(cols, rows) {
        if (exited) return;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 500) throw new Error('Invalid terminal dimensions');
        handle.terminal.resize(cols, rows);
      },
    };
  }
  const statPath = `/proc/${handle.pid}/stat`;
  const identity = text => text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
  let start;
  try { start = identity(await readFile(statPath, 'utf8')); } catch { return handle; }
  return { pid: handle.pid, output: handle.output, done: handle.done,
    write: data => handle.write(data), terminate: () => handle.terminate(),
    async resize(cols, rows) {
      if (exited) return;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 500) throw new Error('Invalid terminal dimensions');
      if (identity(await readFile(statPath, 'utf8')) !== start || exited) return;
      await run('/usr/bin/stty', ['--file', `/proc/${handle.pid}/fd/0`, 'rows', String(rows), 'cols', String(cols)], { timeout: 3000 });
    },
  };
}

export async function apply(ctx) {
  let occupied = false;
  const webServer = {
    register(route) {
      return ctx.webServer.register({ ...route, handler(req, res) {
        const rejected = ctx.connection.requestRejection(req);
        if (rejected !== undefined) { res.writeHead(rejected); res.end(); return; }
        return route.handler(req, res);
      } });
    },
    registerUpgrade(route) {
      return ctx.webServer.registerUpgrade({ ...route, handler(req, socket, head) {
        const rejected = ctx.connection.requestRejection(req);
        if (rejected !== undefined) { socket.end(`HTTP/1.1 ${rejected} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
        return route.handler(req, socket, head);
      } });
    },
  };
  const unregister = ctx.dshStd.registerUiContributionProvider({
    participantId: 'local.dsh-terminal.panel-provider',
    support: { surfaces: [{ ...surface, modes: ['local-module'] }] },
    register(owner, contribution) {
      if (owner.component !== 'local.terminal-std' || contribution.descriptor.content.abi !== 1 || typeof contribution.localModule?.mount !== 'function') throw new Error('Invalid terminal surface ABI');
      if (occupied) throw new Error('Only one terminal panel is supported');
      const dispose = contribution.localModule.mount({
        webServer,
        spawnTerminal: async spec => resizable(await ctx.subprocess.spawnTerminal(terminalSpec(spec))),
        resolveTarget(target) {
          const ssh = ctx.get('dshSsh');
          if (!ssh) throw new Error('dsh-ssh is not loaded; remote terminal unavailable');
          if (target.kind !== 'ssh' && target.kind !== 'win') throw new Error('Unsupported terminal target');
          return ssh.buildRemoteSpawn({ connectionId: target.connectionId, cwd: target.cwd, ...(target.kind === 'win' ? { shell: target.shell } : {}) });
        },
      });
      occupied = true;
      return async () => { try { await dispose(); } finally { occupied = false; } };
    },
  });
  let unmount;
  try {
    const manifestUrl = new URL('../terminal-std/component.manifest.json', import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    unmount = await ctx.dshStd.mount({ manifest, facet: 'host', activate: context => facet.activate(context) });
  } catch (error) { await unregister(); throw error; }
  ctx.effect(() => async () => { try { await unmount(); } finally { await unregister(); } });
}
