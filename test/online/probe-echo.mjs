#!/usr/bin/env node
/**
 * “尾字符重复”归因探针（主 agent 用，只读探测）。
 * 通过在线 WS 桥开一个真实 zsh 会话，逐字节记录 zsh 对输入的回显序列：
 *   1) 发送 'clear'（不回车）→ 收集回显 A（期望恰好是 c/l/e/a/r 各一次）
 *   2) 发送 '\r'（回车）→ 收集回显 B（看 zsh/p10k 在 accept-line 时重绘出了什么，
 *      若 B 里再次出现 'r' 或整行 'clear' 文本，说明重复来自 zsh 侧的转义序列，
 *      否则问题在浏览器渲染层）
 *   3) 对照组：'zsh -f'（无 p10k）里重复 1)2)，排除 p10k 影响。
 * 输出：每段字节的 JSON-escaped 形式（escape 可见化）+ 是否含可疑重复。
 * 用法: node probe-echo.mjs [wsUrl]
 */
const WS_URL = process.argv[2] ?? 'ws://127.0.0.1:3080/__dsh-terminal/ws'
const COLS = 120, ROWS = 30

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const visible = (s) => JSON.stringify(s).slice(0, 4000)

let out = Buffer.alloc(0)
let ws
let ready = false
const done = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 45000)
  ws = new WebSocket(WS_URL)
  ws.binaryType = 'arraybuffer'
  ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')) }
  ws.onclose = () => { clearTimeout(t); resolve() }
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data)
      if (m.t === 'ready') ready = true
      if (m.t === 'exit') { clearTimeout(t); resolve() }
    } else {
      out = Buffer.concat([out, Buffer.from(ev.data)])
    }
  }
})

function takeChunk() { const s = out.toString('utf8'); out = Buffer.alloc(0); return s }
async function step(label, input, settleMs) {
  if (input !== null) ws.send(Buffer.from(input, 'utf8'))
  await sleep(settleMs)
  const chunk = takeChunk()
  console.log(`\n### ${label} (${chunk.length}B)`)
  console.log(visible(chunk))
  return chunk
}

ws.onopen = async () => ws.send(JSON.stringify({ t: 'spawn', cols: COLS, rows: ROWS }))
while (!ready) await sleep(50)
await step('banner/motd settle', null, 2500)

// 逐键发送模拟真人输入
const echo1 = ''
await step("send 'c'", 'c', 300)
await step("send 'l'", 'l', 300)
await step("send 'e'", 'e', 300)
await step("send 'a'", 'a', 300)
const lastKey = await step("send 'r'", 'r', 500)
console.log(`\n>> 末键 'r' 回显=${visible(lastKey)} （期望：恰好一个 r）`)

const accept = await step("send '\\r' (accept-line)", '\r', 1500)
console.log(`>> 回显里再次出现的整行/尾字符: ${accept.includes('clear') ? '含 clear 文本' : '不含'} / 尾部 r 计数=${(accept.match(/r/g) || []).length}`)

// 对照组：无 p10k 的 zsh -f
await step("enter 'zsh -f'", 'zsh -f\r', 1500)
await step("plain send 'clear'", 'clear', 600)
const accept2 = await step("plain send '\\r'", '\r', 1200)
console.log(`>> [zsh -f] accept 段尾部 r 计数=${(accept2.match(/r/g) || []).length}`)

// 清场退出
await step("exit zsh -f", 'exit\r', 800)
await step("exit outer", 'exit\r', 800)
try { ws.close() } catch {}
await Promise.race([done, sleep(3000)])
console.log('\nprobe done')
process.exit(0)
