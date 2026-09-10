/**
 * 默认 shell 解析 + 可选 shell 探测（cordis 无关的纯 Node 函数）。
 *
 * - `resolveShell()`：默认 shell —— `process.env.SHELL` → 解析 `/etc/passwd`
 *   当前用户行第 7 字段 → `/bin/sh`。
 * - `detectShells()`：可用 shell 列表（M2 终端类型选择）。候选顺序：
 *   `process.env.SHELL`（解析为绝对路径，existsSync 校验）→ `/usr/bin/zsh`、
 *   `/bin/zsh`、`/bin/bash`、`/usr/bin/bash`、`/bin/sh`、`/usr/bin/fish`、
 *   `/bin/fish`、`/bin/dash` → 按 PATH 找 `pwsh`/`powershell`（Windows 分支
 *   简单支持 pwsh/powershell/cmd）。按 realpath 去重（首见者胜），
 *   path 一律返回规范 realpath，name=basename，isDefault=与 resolveShell() 同路径。
 * - `findAllowedShell(requested, shells)`：spawn 帧 shell 字段的 allowlist 校验
 *   —— 先字面匹配列表 path（精确），再对存在的路径做 realpath 别名匹配
 *   （/bin/bash 与 /usr/bin/bash 同体时任一可过），防任意路径注入。
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, resolve as resolvePath, sep } from 'node:path'

export interface ResolvedShell {
  argv: string[]
  name: string
}

/** M2：探测到的可用 shell（终端类型选择的下拉数据 + spawn 帧 allowlist）。 */
export interface DetectedShell {
  name: string
  path: string
  isDefault: boolean
}

/** 从 /etc/passwd 找当前 uid 对应行的 shell 字段（找不到返回 undefined）。 */
function shellFromPasswd(): string | undefined {
  const getuid = (process as { getuid?: () => number }).getuid
  if (typeof getuid !== 'function') return undefined
  let passwd: string
  try {
    passwd = readFileSync('/etc/passwd', 'utf8')
  } catch {
    return undefined
  }
  const uid = getuid.call(process)
  for (const line of passwd.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue
    const fields = line.split(':')
    if (fields.length < 7) continue
    if (Number(fields[2]) === uid) {
      const shell = fields[6].trim()
      return shell.length > 0 ? shell : undefined
    }
  }
  return undefined
}

/** 解析当前环境默认 shell。 */
export function resolveShell(): ResolvedShell {
  if (process.platform === 'win32') {
    const shell = findInPath('pwsh') ?? findInPath('powershell') ?? process.env.ComSpec ?? findInPath('cmd');
    if (!shell) throw new Error('No Windows shell found on PATH');
    return { argv: [shell], name: basename(shell) }
  }
  const fromEnv = process.env.SHELL
  const shell = (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined) ?? shellFromPasswd() ?? '/bin/sh'
  return { argv: [shell], name: basename(shell) }
}

/** realpath 容错（不存在/无权限一律 undefined）。 */
function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** PATH 分隔符（POSIX ':' / Windows ';'）。 */
function pathListDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

/** 按 PATH 找可执行文件，返回第一个存在的绝对路径（找不到 undefined）。 */
function findInPath(bin: string): string | undefined {
  const entries = (process.env.PATH ?? '').split(pathListDelimiter())
  for (const dir of entries) {
    if (dir.length === 0) continue
    const suffixes = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(bin) ? ['.exe', ''] : ['']
    for (const suffix of suffixes) {
      const candidate = resolvePath(dir.replace(/^"|"$/g, ''), bin + suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 把候选解析为存在的绝对路径（不存在返回 undefined）。 */
function absoluteShellPath(raw: string): string | undefined {
  if (raw.length === 0) return undefined
  const candidate: string | undefined = isAbsolute(raw)
    ? raw
    : (raw.includes(sep) || (process.platform === 'win32' && raw.includes('/'))
        ? resolvePath(raw)
        : findInPath(raw))
  if (candidate === undefined) return undefined
  return existsSync(candidate) ? candidate : undefined
}

/** shell 候选（含 SHELL 环境变量与固定路径；Windows 走 PATH 找 pwsh/powershell/cmd）。 */
function shellCandidates(): string[] {
  const fromEnv = process.env.SHELL
  const list: string[] = []
  if (fromEnv !== undefined && fromEnv.length > 0) list.push(fromEnv)
  if (process.platform === 'win32') {
    for (const bin of ['pwsh', 'powershell', 'cmd']) {
      const found = findInPath(bin)
      if (found !== undefined) list.push(found)
    }
  } else {
    list.push(
      '/usr/bin/zsh', '/bin/zsh', '/bin/bash', '/usr/bin/bash',
      '/bin/sh', '/usr/bin/fish', '/bin/fish', '/bin/dash',
    )
  }
  return list
}

/**
 * 探测可用 shell（M2）。去重按 realpath（首见者胜），返回的 path 是规范
 * realpath，name=basename，isDefault 与 resolveShell() 同路径。
 */
export function detectShells(): DetectedShell[] {
  const defaultShell = resolveShell()
  const defaultPath = tryRealpath(defaultShell.argv[0]) ?? defaultShell.argv[0]
  const seen = new Set<string>()
  const result: DetectedShell[] = []
  for (const raw of shellCandidates()) {
    const absolute = absoluteShellPath(raw)
    if (absolute === undefined) continue
    const real = tryRealpath(absolute) ?? absolute
    if (seen.has(real)) continue
    seen.add(real)
    result.push({ name: basename(real), path: real, isDefault: real === defaultPath })
  }
  return result
}

/**
 * spawn 帧 shell 字段的 allowlist 校验：requested 必须是 shells 中的 path
 * （字面匹配优先；对存在的路径再比 realpath，覆盖符号链接别名，
 * 如 /bin/bash ⇢ /usr/bin/bash）。命中返回对应条目，否则 undefined（回 error 帧）。
 */
export function findAllowedShell(requested: string, shells: DetectedShell[]): DetectedShell | undefined {
  const literal = shells.find((shell) => shell.path === requested)
  if (literal !== undefined) return literal
  const requestedReal = tryRealpath(requested)
  if (requestedReal !== undefined) {
    const alias = shells.find((shell) => shell.path === requestedReal)
    if (alias !== undefined) return alias
  }
  return undefined
}
