#!/usr/bin/env node
/**
 * dsh-terminal M1 在线验收脚本（主 agent 用）。
 * 直接打运行中的 dsh web 进程的 WS 桥：spawn 默认 shell → 输出 → resize → exit。
 * 依赖为零（Node >=22 内置 WebSocket 客户端）。
 *
 * 用法: node accept-ws.mjs [wsUrl]
 * 默认  ws://127.0.0.1:3080/__dsh-terminal/ws
 * 退出码 0 = 全部通过。
 */

const WS_URL = process.argv[2] ?? 'ws://127.0.0.1:3080/__dsh-terminal/ws'
const TIMEOUT_MS = 20_000

const results = []
let output = ''
let ready = null
let exited = null
let ws

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function sendJson(obj) { ws.send(JSON.stringify(obj)) }
function sendInput(text) { ws.send(Buffer.from(text, 'utf8')) }

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  ws = new WebSocket(WS_URL)
  ws.binaryType = 'arraybuffer'
  ws.onopen = async () => {
    try {
      sendJson({ t: 'spawn', cols: 80, rows: 24 })
    } catch (e) { clearTimeout(timer); reject(e) }
  }
  ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws error: ' + (e.message ?? 'unknown'))) }
  ws.onclose = (e) => { clearTimeout(timer); resolve({ closed: true, code: e.code }) }
  ws.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'ready') ready = msg
      if (msg.t === 'exit') { exited = msg; clearTimeout(timer); resolve({ closed: false }) }
      if (msg.t === 'error') { clearTimeout(timer); reject(new Error('server error frame: ' + msg.message)) }
    } else {
      output += Buffer.from(ev.data).toString('utf8')
      // 驱动后续步骤
      await drive()
    }
  }
})

let step = 0
async function drive() {
  if (step === 0 && ready) {
    step = 1
    await sleep(800) // 等 motd/banner 吐完
    check('spawn → ready 帧', true, `pid=${ready.pid} shell=${ready.shell ?? '?'}`)
    check('初始输出非空(提示符/banner)', output.length > 0, `${output.length} bytes`)
    output = ''
    sendInput('echo ZSHV=$ZSH_VERSION; echo SZ:$(stty size):END\n')
    step = 2
    return
  }
  if (step === 2 && /ZSHV=[\d.]+/.test(output) && /SZ:\d+ \d+:END/.test(output)) {
    const zsh = output.match(/ZSHV=([\d.]+)/)?.[1]
    const size = output.match(/SZ:(\d+) (\d+):END/)
    check('默认 shell 是 zsh', !!zsh, zsh ? `zsh ${zsh}` : `输出: ${JSON.stringify(output.slice(-120))}`)
    check('初始尺寸 80x24', size?.[1] === '24' && size?.[2] === '80', size ? `stty=${size[1]} ${size[2]}` : '未解析')
    output = ''
    sendJson({ t: 'resize', cols: 100, rows: 40 })
    await sleep(300)
    sendInput('echo SZ2:$(stty size):END\n')
    step = 3
    return
  }
  if (step === 3 && /SZ2:40 100:END/.test(output)) {
    check('resize 100x40 生效(stty size=40 100)', true)
    output = ''
    sendInput('exit\n')
    step = 4
    return
  }
  if (step === 3 && /SZ2:\d+ \d+:END/.test(output) && !/SZ2:40 100:END/.test(output)) {
    check('resize 100x40 生效(stty size=40 100)', false, `实际: ${output.match(/SZ2:[^:]*:END/)?.[0]}`)
    sendInput('exit\n')
    step = 4
  }
}

try {
  await done
  check('exit 帧到达', exited !== null, exited ? `code=${exited.exitCode}` : 'WS 关闭但无 exit 帧')
} catch (e) {
  check('链路完整', false, e.message)
} finally {
  try { ws?.close() } catch {}
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
