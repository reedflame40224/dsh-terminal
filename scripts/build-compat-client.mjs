import { readFile, writeFile } from 'node:fs/promises';
import { createResizeController } from '../compat/terminal-dsh-bridge/resize-controller.mjs';
const input = new URL('../lib/client.js', import.meta.url);
let source = await readFile(input, 'utf8');
const wsStart = source.indexOf('\t\tconst WS_PATH =');
const commentStart = source.lastIndexOf('\t\t/**', wsStart);
if (wsStart < 0 || commentStart < 0) throw new Error('Terminal session header changed');
source = source.slice(0, commentStart) + '\t\t/** Font/layout-aware terminal session; resize commits xterm and PTY together. */\n' + source.slice(wsStart);
function replace(before, after) {
  if (source.split(before).length !== 2) throw new Error(`Terminal client anchor changed: ${before.slice(0, 80)}`);
  source = source.replace(before, after);
}
replace('\t\tconst RESIZE_QUIET_MS = 300;\n', '');
replace('\t\tconst NARROW_DEFER_MS = 150;\n', '');
const start = source.indexOf('\t\t\tlet lastSent = null;');
const end = source.indexOf('\t\t\tlet resolveCancelled;', start);
if (start < 0 || end < start) throw new Error('Terminal resize block changed');
source = source.slice(0, start) + `
      let lastSent = null;
      let dataSubscription = null;
      let layoutObserver = null;
      let resizeObserver = null;
      let fitRaf = 0;
      const sendResize = (cols, rows) => {
        if (disposed || !spawned || ws?.readyState !== WebSocket.OPEN) return;
        if (lastSent?.cols === cols && lastSent?.rows === rows) return;
        ws.send(JSON.stringify({ t: 'resize', cols, rows }));
        lastSent = { cols, rows };
      };
      const resize = (${createResizeController.toString()})({
        term, send: sendResize, ready: () => spawned,
        propose: () => {
          if (container.clientWidth <= 0 || container.clientHeight <= 0) return null;
          const size = fitAddon.proposeDimensions();
          return size && Number.isFinite(size.cols) && Number.isFinite(size.rows)
            ? { cols: Math.max(2, size.cols), rows: Math.max(1, size.rows) } : null;
        },
      });
` + source.slice(end);
const subStart = source.indexOf('\t\t\t\tresizeSubscription = term.onResize(');
const subEnd = source.indexOf('\t\t\t\tresizeObserver = new ResizeObserver', subStart);
if (subStart < 0 || subEnd < subStart) throw new Error('Terminal resize subscription changed');
source = source.slice(0, subStart) + source.slice(subEnd);
replace('const proposed = safePropose();\n\t\t\t\t\t\tif (proposed === null) return;\n\t\t\t\t\t\trouteProposedSize(proposed.cols, proposed.rows, false);', 'resize.fit();');
replace('sendResize(term.cols, term.rows);', 'resize.fit(true);');
const methodsStart = source.indexOf('\t\t\t\tfit() {', source.indexOf('function createTerminalSession('));
const methodsEnd = source.indexOf('\t\t\t\tdispose() {', methodsStart);
if (methodsStart < 0 || methodsEnd < methodsStart) throw new Error('Terminal resize methods changed');
source = source.slice(0, methodsStart) + '\t\t\t\tfit() { resize.fit(); },\n\t\t\t\tbeginResize() { resize.begin(); },\n\t\t\t\tendResize() { resize.end(); },\n' + source.slice(methodsEnd);
replace('for (const id of refreshFallbackTimers) clearTimeout(id);\n\t\t\t\t\trefreshFallbackTimers = [];', 'resize.dispose();');
replace('if (endResizeRaf !== 0) cancelAnimationFrame(endResizeRaf);', '');
replace('resizeSubscription?.dispose();', '');
const cleanStart = source.indexOf('\t\t\t\t\tif (resizeTimer !== void 0)', source.indexOf('\t\t\t\tdispose() {', methodsStart));
const cleanEnd = source.indexOf('\t\t\t\t\ttry {', cleanStart);
if (cleanStart < 0 || cleanEnd < cleanStart) throw new Error('Terminal resize disposal changed');
source = source.slice(0, cleanStart) + source.slice(cleanEnd);
await writeFile(new URL('../compat/terminal-dsh-bridge/lib/client.js', import.meta.url), source.replace(/^[\t ]+$/gm, ''));
console.log('Built synchronized terminal resize client');
