# dsh-std Compatibility

The default package entry now uses `compat/terminal-dsh-bridge/index.mjs`.
The component implementation is in `compat/terminal-std`; the original
TypeScript plugin and browser sources remain in `src/` with their history.

## Requirements

- Verified DSH host: `0.1.2-rc.1` (also tested on `0.1.2-alpha.2`).
- Enable `@dsh-std/adapter-dsh@0.1.1-rc.2` in the Web profile before this plugin.
- Node.js 24 or later, with a working host PTY implementation.
- Use a file link to a source checkout outside `node_modules`: the vendored
  TypeScript uses Node's built-in stripping, restricted inside `node_modules`.
- Remote browser terminals additionally require the compatible dsh-ssh plugin.

This implementation uses an internal component manifest and a DSH-specific
UI surface, not the Community 0.15 portable package format.

## Build And Test

```sh
pnpm install --frozen-lockfile
pnpm bundle
pnpm test
```

The build compiles the original browser source, then applies
`scripts/build-compat-client.mjs`. The verified browser entry is tracked for
source checkouts. Fonts continue to use the repository's `assets/fonts`.
`pnpm bundle:legacy` only rebuilds the original implementation; it does not
change the package's default compatibility entry.

## Resize Fix

The resize controller freezes intermediate sizes during dragging and commits
the final size in the required order: xterm before the PTY when widening,
PTY before xterm when narrowing. The narrowing delay lets the shell repaint
before xterm reflows the display. Stale callbacks are cancelled.

The bridge uses a native resize method when available and adapts older PTY
handles otherwise. Linux shells receive `TERM=xterm-256color` to compensate
for the older host's `dumb` setting. Tests cover lifecycle cleanup and resize
ordering; earlier real-browser acceptance checked long-input preservation
and matching PTY dimensions. SSH real-machine acceptance also covered
remote input/output, resize and exit.

No user profiles, terminal history, passwords or live connection records
belong in this repository.
