/**
 * dsh-terminal M2 离线 e2e：shell 探测与 allowlist（纯函数，不依赖 node-pty）。
 *
 * 覆盖 detectShells()/findAllowedShell()（检测与校验）的离线不变量：
 *   - 列表非空；path 存在；name === basename(path)；realpath 去重（无重复体）；
 *   - 恰一个 isDefault，且其 realpath 与 resolveShell() 相同；
 *   - findAllowedShell：字面命中 / realpath 别名命中（/bin/bash ⇢ /usr/bin/bash）/
 *     不存在的路径返回 undefined；
 *   - 桥 spawn 的 allowlist 行为本身在 bridge.e2e.mjs S2/S3 覆盖。
 *
 * 纯 node 运行：`node test/shells.e2e.mjs`；退出码 0/非 0 表成败。
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveShell, detectShells, findAllowedShell } from '../src/shell.ts'

const fail = (reason) => {
  console.error('[shells] FAIL:', reason)
  process.exit(1)
}

const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[shells] ok: ${label}`)
}

const tryRealpath = (path) => {
  try { return realpathSync(path) } catch { return undefined }
}

// 1) 非空
const shells = detectShells()
guard(shells.length > 0, `detectShells() 非空（${shells.length} 个）`)

// 2) 每条：path 存在、name 是 basename、isDefault 布尔
for (const shell of shells) {
  guard(existsSync(shell.path), `path 存在: ${shell.path}`)
  guard(shell.name === basename(shell.path), `name === basename: ${shell.name} = ${basename(shell.path)}`)
  guard(typeof shell.isDefault === 'boolean', `isDefault 为布尔: ${shell.path}`)
}

// 3) realpath 去重
const reals = shells.map((shell) => tryRealpath(shell.path) ?? shell.path)
guard(new Set(reals).size === reals.length, `realpath 去重（无重复体）: ${reals.join(', ')}`)

// 4) 恰一个 isDefault，且与 resolveShell() 同 realpath
const defaults = shells.filter((shell) => shell.isDefault)
guard(defaults.length === 1, `恰一个 isDefault（${defaults.length} 个）`)
const resolvedDefault = resolveShell()
const resolvedReal = tryRealpath(resolvedDefault.argv[0]) ?? resolvedDefault.argv[0]
guard(defaults[0].path === resolvedReal, `isDefault 与 resolveShell() 同路径: ${defaults[0].path} == ${resolvedReal}`)

console.log(`[shells] detectShells(): ${shells.map((s) => `${s.name}@${s.path}${s.isDefault ? '（默认）' : ''}`).join(' | ')}`)

// 5) findAllowedShell：默认 shell 字面命中
const defaultHit = findAllowedShell(resolvedDefault.argv[0], shells)
guard(defaultHit !== undefined && defaultHit.path === resolvedReal, `findAllowedShell(默认 shell) 命中 ${resolvedReal}`)

// 6) findAllowedShell：/bin/bash 通过 realpath 别名命中（本机 /bin/bash ⇢ /usr/bin/bash）
const bash = shells.find((shell) => shell.name === 'bash')
if (bash !== undefined) {
  const alias = findAllowedShell('/bin/bash', shells)
  guard(alias !== undefined && alias.name === 'bash', `findAllowedShell('/bin/bash') 别名命中 => ${alias?.path}`)
} else {
  console.log('[shells] note: 本机未探测到 bash，跳过别名用例')
}

// 7) findAllowedShell：不存在的路径 → undefined（allowlist 拒绝）
guard(findAllowedShell('/no/such/shell', shells) === undefined, `findAllowedShell('/no/such/shell') 拒绝`)

console.log('PASS: detectShells/findAllowedShell 不变量全部通过')
process.exit(0)