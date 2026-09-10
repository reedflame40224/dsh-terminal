import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolveShell, detectShells } from '../vendor/shell.ts';

test('native Windows finds an executable default shell without a POSIX SHELL', { skip: process.platform !== 'win32' }, () => {
  const previous = process.env.SHELL;
  delete process.env.SHELL;
  try {
    const shell = resolveShell();
    assert.ok(existsSync(shell.argv[0]));
    assert.match(shell.argv[0], /\.exe$/i);
    assert.ok(detectShells().some(row => row.isDefault));
  } finally { if (previous !== undefined) process.env.SHELL = previous; }
});
