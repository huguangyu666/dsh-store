/**
 * togglePlugin 独立单元测试：验证停用/启用不依赖外部数据源
 * 直接构造 profile patch，验证：
 * 1. 停用：disabled 4 空格缩进、挂在目标条目内、不跨条目
 * 2. 启用：删除目标条目内的 disabled
 * 3. 多条目时不影响其他条目
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE || process.env.HOME
const profileDir = join(home, '.dsh', 'profiles', 'toggle-test')
rmSync(profileDir, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'toggle-test', private: true }))
// 构造两个插件的 patch（notify + store）
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '- insert:',
  "    - id: notify",
  "      name: 'dsh-plugin-notify'",
  "    - id: plugin-store",
  "      name: 'dsh-store'",
  '',
].join('\n'))

process.env.DSH_PLUGIN_STORE_PROFILE = 'toggle-test'
const m = await import('./lib/index.js')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

// 通过路由调用 toggle（走真实 handler）
const routes = new Map()
const fakeCtx = { webServer: { register: (r) => routes.set(r.path, r) }, commands: { register: () => {} } }
m.apply(fakeCtx)
const callToggle = async (name, enable) => {
  const res = { statusCode: 0, body: '' }
  res.writeHead = (c) => { res.statusCode = c }
  res.end = (d) => { res.body = d.toString() }
  const req = { method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ name, enable })) } }
  await routes.get('/plugin-store/api/toggle').handler(req, res)
  return JSON.parse(res.body)
}
const readPatch = () => readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')

// 1. 停用 notify
const r1 = await callToggle('dsh-plugin-notify', false)
check('停用 notify 返回 enabled:false', r1.enabled === false, JSON.stringify(r1))
const p1 = readPatch()
check('notify 的 disabled 是 4 空格缩进', p1.includes("    disabled: true"), JSON.stringify(p1))
check('disabled 紧跟 notify 条目', p1.indexOf("name: 'dsh-plugin-notify'") < p1.indexOf("    disabled: true"))
check('plugin-store 条目没被加 disabled', !p1.split('- insert:')[1].split("id: plugin-store")[1].startsWith("\n      disabled") && !/id: plugin-store[\s\S]*?disabled: true/.test(p1.split('- insert:')[1].split("id: plugin-store")[1] || ''), 'store 不应被误停用')

// 2. 启用 notify
const r2 = await callToggle('dsh-plugin-notify', true)
check('启用 notify 返回 enabled:true', r2.enabled === true, JSON.stringify(r2))
const p2 = readPatch()
check('启用后 notify 的 disabled 被移除', !/id: notify[\s\S]*?disabled: true/.test(p2), JSON.stringify(p2))

// 3. 停用 store（验证第二个条目也能正确停用）
const r3 = await callToggle('dsh-store', false)
check('停用 store 返回 enabled:false', r3.enabled === false, JSON.stringify(r3))
const p3 = readPatch()
check('store 的 disabled 4 空格', p3.includes("    disabled: true"), JSON.stringify(p3))
check('store disabled 在 store 条目内', p3.indexOf("name: 'dsh-store'") < p3.indexOf("    disabled: true"))

// 4. 多条目互不影响：notify 不应有 disabled
const p3lines = p3.split(String.fromCharCode(10)); const nIdx = p3lines.findIndex(l => l.includes('id: notify')); const nEnd = p3lines.findIndex((l, i) => i > nIdx && /^\s*- id:/.test(l)); const notifyBlock = p3lines.slice(nIdx, nEnd === -1 ? p3lines.length : nEnd); check('notify 未被误停用', !notifyBlock.some(l => /disabled:\s*true/.test(l)), JSON.stringify(p3))

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
