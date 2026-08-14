/**
 * dsh-plugin-store mock/集成测试：
 * 1. 路由/命令注册检查
 * 2. 目录引擎真实拉取（npm 关键词搜索 + GitHub 星标合并 + dsh 字段验证）
 * 3. 安装引擎（隔离 profile store-test：pnpm add → patch 合并 → 幂等 → 卸载清理）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE || process.env.HOME
const profileDir = join(home, '.dsh', 'profiles', 'store-test')
const storeDir = join(home, '.dsh', 'plugin-store')

// 清缓存与隔离 profile（保证每次测试从真实拉取开始）
rmSync(storeDir, { recursive: true, force: true })
rmSync(profileDir, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-store-test', private: true, dependencies: {} }, null, 2))
writeFileSync(join(profileDir, 'cordis.patch.yml'), '- insert: []\n')

process.env.DSH_PLUGIN_STORE_PROFILE = 'store-test'
process.env.DSH_PLUGIN_STORE_PROXY = 'http://127.0.0.1:7892'

const routes = new Map()
const commands = new Map()
const fakeCtx = {
  webServer: { register: (r) => routes.set(r.path, r) },
  commands: { register: (c) => commands.set(c.name, c) },
}
const m = await import('./lib/index.js')
m.apply(fakeCtx)

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

// 1. 注册检查
check('路由 /plugin-store', routes.has('/plugin-store'))
check('路由 /plugin-store/api/catalog', routes.has('/plugin-store/api/catalog'))
check('路由 install/uninstall/refresh/restart',
  routes.has('/plugin-store/api/install') && routes.has('/plugin-store/api/uninstall') &&
  routes.has('/plugin-store/api/refresh') && routes.has('/plugin-store/api/restart'))
check('命令 plugin-store + plugin-install', commands.has('plugin-store') && commands.has('plugin-install'))

// 2. 目录引擎（真实网络拉取）
const catalogRes = mockRes()
await routes.get('/plugin-store/api/catalog').handler({}, catalogRes)
const catalog = JSON.parse(catalogRes.body)
check('目录拉取成功且有插件', catalogRes.statusCode === 200 && (catalog.plugins?.length ?? 0) > 0, `count=${catalog.plugins?.length}`)
check('包含已知插件 dsh-plugin-notify', catalog.plugins?.some((p) => p.name === 'dsh-plugin-notify'))
check('包含已知插件 dsh-plugin-session-import', catalog.plugins?.some((p) => p.name === 'dsh-plugin-session-import'))
const hasStars = catalog.plugins?.some((p) => (p.stars ?? 0) > 0)
console.log('INFO 有星标数据:', hasStars ? '是（GitHub 合并成功）' : '否（GitHub 可能被墙，星标为 0，不影响安装）')
const sorted = catalog.plugins ?? []
check('按星标排序', sorted.every((p, i) => i === 0 || sorted[i - 1].stars >= p.stars))
check('awesome 精选已合并（curated 条目 > 0）', (catalog.plugins?.filter((p) => p.curated === true).length ?? 0) > 0)
check('分类已打（category 条目 > 0）', (catalog.plugins?.filter((p) => !!p.category).length ?? 0) > 0)
const nonNpm = catalog.plugins?.filter((p) => p.installable === false) ?? []
console.log('INFO 未上 npm 的精选条目:', nonNpm.length, '（这些显示为 GitHub 跳转，不可一键安装）')

// 3. 安装引擎（真实 pnpm add 到隔离 profile）
const instRes = mockRes()
await routes.get('/plugin-store/api/install').handler(mockReq({ name: 'dsh-plugin-notify' }), instRes)
const inst = JSON.parse(instRes.body)
check('安装成功', instRes.statusCode === 200 && inst.ok === true, inst.error ?? '')
check('patch 已合并', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('dsh-plugin-notify'))
const pkg1 = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
check('package.json 依赖已记录', !!pkg1.dependencies?.['dsh-plugin-notify'])
check('node_modules 已落地', existsSync(join(profileDir, 'node_modules', 'dsh-plugin-notify', 'cordis.patch.yml')))
const patchAfterInstall = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
check('patch 结构合法（块结构）', patchAfterInstall.includes('- insert:\n') && !patchAfterInstall.includes('- insert: []\n    - id:'))

// 幂等：重复安装不产生重复行
await routes.get('/plugin-store/api/install').handler(mockReq({ name: 'dsh-plugin-notify' }), mockRes())
const patch2 = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
check('重复安装幂等（id 只出现一次）', (patch2.match(/- id: notify/g) ?? []).length === 1)

// 已安装状态反映
const cat2Res = mockRes()
await routes.get('/plugin-store/api/catalog').handler({}, cat2Res)
const cat2 = JSON.parse(cat2Res.body)
const notifyEntry = cat2.plugins?.find((p) => p.name === 'dsh-plugin-notify')
check('已安装状态标记', notifyEntry?.installed === true)

// 卸载
const unRes = mockRes()
await routes.get('/plugin-store/api/uninstall').handler(mockReq({ name: 'dsh-plugin-notify' }), unRes)
check('卸载成功', unRes.statusCode === 200 && JSON.parse(unRes.body).ok === true)
const patch3 = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
const pkg3 = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
check('卸载后 patch 清理', !patch3.includes('dsh-plugin-notify'))
check('卸载后依赖清理', !pkg3.dependencies?.['dsh-plugin-notify'])

// 3.5 未上 npm 的条目不可安装（返回 400）
const nonNpmEntry = cat2.plugins?.find((p) => p.installable === false)
if (nonNpmEntry) {
  const rejectRes = mockRes()
  await routes.get('/plugin-store/api/install').handler(mockReq({ name: nonNpmEntry.name }), rejectRes)
  check('未上 npm 安装被拒（400）', rejectRes.statusCode === 400, JSON.stringify(JSON.parse(rejectRes.body || '{}')))
} else {
  console.log('INFO 无未上 npm 条目可测，跳过')
}

// 4. 命令
const cmdRes = await commands.get('plugin-store').handler({ rawInput: '' })
check('命令返回摘要', cmdRes?.kind === 'success' && cmdRes.text.includes('plugin-store'))

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
// 5. AdamPlatin123 雷达集成检查（真实拉取）
const radarRes = mockRes()
await routes.get('/plugin-store/api/catalog').handler({}, radarRes)
const radarCat = JSON.parse(radarRes.body)
const radarCount = radarCat.plugins?.filter((p) => p.radarStatus).length ?? 0
console.log('INFO 带雷达状态条目:', radarCount)
check('雷达状态已合并（>0）', radarCount > 0)
const sess = radarCat.plugins?.find((p) => p.name === 'dsh-plugin-session-import')
check('session-import 有雷达状态', !!sess?.radarStatus, sess?.radarStatus ?? '')

process.exit(fail === 0 ? 0 : 1)

function mockReq(body) {
  return { [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body ?? {})) } }
}
function mockRes() {
  const res = { statusCode: 0, body: '' }
  res.writeHead = (code) => { res.statusCode = code }
  res.end = (data) => { res.body = data.toString() }
  return res
}

