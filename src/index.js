/**
 * dsh-plugin-store — dsh 插件商店
 *
 * 上游基础设施：聚合 npm registry + GitHub 的 dsh 插件目录，
 * 质量验证（package.json 必须有 dsh 字段）+ GitHub 星标排序，
 * 在 dsh 内一键安装 / 卸载（pnpm add + 自动合并 cordis.patch.yml），
 * 装完一键重启生效。
 *
 * 页面：http://<host>:<port>/plugin-store
 * 命令：/plugin-store（摘要）、/plugin-install <名称>
 *
 * 配置：~/.dsh/plugin-store/config.json
 *   { proxy: "http://127.0.0.1:7892", profile: "web" }
 * 环境变量：DSH_PLUGIN_STORE_PROFILE（覆盖 profile）、DSH_PLUGIN_STORE_PROXY（覆盖 proxy）
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-store'

export const inject = ['commands', 'webServer']

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const homeDir = process.env.USERPROFILE || process.env.HOME || ''
const STORE_DIR = join(homeDir, '.dsh', 'plugin-store')
const CONFIG_FILE = join(STORE_DIR, 'config.json')
const CATALOG_FILE = join(STORE_DIR, 'catalog.json')
const VERIFY_DIR = join(STORE_DIR, 'verify')
const CATALOG_TTL = 24 * 60 * 60 * 1000
const VERIFY_TTL = 7 * 24 * 60 * 60 * 1000
const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250'
const GH_SEARCH_URL = 'https://api.github.com/search/repositories?q=topic%3Adsh-plugin&sort=stars&per_page=100'
const AWESOME_URL = 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md'
const AWESOME_CACHE = join(homeDir, '.dsh', 'plugin-store', 'awesome.json')

// ── 配置 ──
let _config = null
function loadConfig() {
  if (_config) return _config
  const cfg = { proxy: '', profile: 'web' }
  if (process.env.DSH_PLUGIN_STORE_PROXY) cfg.proxy = process.env.DSH_PLUGIN_STORE_PROXY
  else cfg.proxy = process.env.HTTPS_PROXY || ''
  if (process.env.DSH_PLUGIN_STORE_PROFILE) cfg.profile = process.env.DSH_PLUGIN_STORE_PROFILE
  try {
    const d = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof d.proxy === 'string') cfg.proxy = d.proxy
    if (typeof d.profile === 'string') cfg.profile = d.profile
  } catch { /* 无配置文件用默认 */ }
  _config = cfg
  return cfg
}
function getProfileDir() {
  return join(homeDir, '.dsh', 'profiles', loadConfig().profile)
}
function ensureStoreDirs() {
  mkdirSync(STORE_DIR, { recursive: true })
  mkdirSync(VERIFY_DIR, { recursive: true })
}

// ── HTTP（curl + 可选代理；npm 直连，GitHub 走代理）──
function httpGetJson(url, { headers = {}, proxy = false, timeout = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (proxy && loadConfig().proxy) {
      env.HTTPS_PROXY = loadConfig().proxy
      env.HTTP_PROXY = loadConfig().proxy
    }
    const args = ['-sS', '--max-time', String(timeout), url]
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
    execFile('curl', args, {
      encoding: 'utf8', env, windowsHide: true, timeout: timeout * 1000 + 5000,
    }, (err, stdout, stderr) => {
      if (err || !stdout || !stdout.trim()) {
        return reject(new Error(`GET ${url} 失败${stderr ? '：' + stderr.slice(0, 200) : ''}`))
      }
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`JSON 解析失败: ${url}`)) }
    })
  })
}

// ── 目录引擎 ──
/** npm registry 关键词精确搜索 → 基础条目（真实 dsh 插件） */
async function fetchNpmEntries() {
  const data = await httpGetJson(NPM_SEARCH_URL, { headers: { Accept: 'application/json' } })
  const out = []
  for (const o of data.objects ?? []) {
    const p = o.package ?? {}
    if (!p.name) continue
    const repoUrl = p.links?.repository || p.links?.homepage || ''
    const mGitHub = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i)
    const repo = mGitHub ? mGitHub[1].replace(/\/+$/, '') : ''
    out.push({
      name: p.name,
      version: p.version || '',
      description: (p.description || '').trim(),
      author: p.author?.name || p.publisher?.username || (p.maintainers?.[0]?.username ?? ''),
      date: p.date || '',
      repo,
      homepage: p.links?.homepage || (repo ? `https://github.com/${repo}` : p.links?.npm || ''),
      stars: 0,
      installKind: 'npm',
    })
  }
  return out
}

/** GitHub topic 搜索 → 星标映射 + 未发布 npm 的仓库（仅展示，不提供一键安装） */
async function fetchGithubStars() {
  const byName = new Map()
  try {
    const data = await httpGetJson(GH_SEARCH_URL, { headers: { 'User-Agent': 'dsh-store', Accept: 'application/vnd.github+json' }, proxy: true })
    for (const r of data.items ?? []) {
      byName.set(r.full_name.toLowerCase(), {
        fullName: r.full_name,
        stars: r.stargazers_count ?? 0,
        updatedAt: r.updated_at ?? '',
        description: (r.description || '').trim(),
        htmlUrl: r.html_url || '',
        author: r.owner?.login ?? '',
      })
    }
  } catch (e) {
    console.warn('[plugin-store] GitHub 星标获取失败（目录仍可用）:', e.message)
  }
  return byName
}

/** 拉取并解析 awesome-dsh-plugin 精选列表 → [ { name, repo, category, desc } ]（缓存 24h）
 * 优先 raw CDN；CDN 未同步时回退 GitHub API（实时、权威）
 */
async function fetchAwesomeList() {
  const ttl = 24 * 60 * 60 * 1000
  try {
    const st = statSync(AWESOME_CACHE)
    if (Date.now() - st.mtimeMs < ttl) {
      const cached = JSON.parse(readFileSync(AWESOME_CACHE, 'utf8'))
      if (Array.isArray(cached)) return cached
    }
  } catch { /* 无缓存 */ }

  // 多来源尝试：raw CDN → GitHub API raw（实时）
  const sources = [
    { url: AWESOME_URL },
    { url: 'https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/README.md', headers: { Accept: 'application/vnd.github.raw+json' } },
  ]
  let md = ''
  for (const src of sources) {
    try {
      const env = { ...process.env }
      if (loadConfig().proxy) { env.HTTPS_PROXY = loadConfig().proxy; env.HTTP_PROXY = loadConfig().proxy }
      const args = ['-sS', '--max-time', '30']
      for (const [k, v] of Object.entries(src.headers ?? {})) args.push('-H', `${k}: ${v}`)
      args.push(src.url)
      md = await new Promise((resolve, reject) => {
        execFile('curl', args, { encoding: 'utf8', env, windowsHide: true, timeout: 40000 }, (err, stdout, stderr) => {
          if (err || !stdout || !stdout.includes('### ')) return reject(new Error('拉取失败' + (stderr ? '：' + stderr.slice(0, 150) : '')))
          resolve(stdout)
        })
      })
      break
    } catch (e) {
      console.warn(`[plugin-store] awesome 来源 ${src.url.slice(0, 55)} 失败:`, e.message)
    }
  }
  if (!md) {
    try {
      const cached = JSON.parse(readFileSync(AWESOME_CACHE, 'utf8'))
      if (Array.isArray(cached)) return cached
    } catch { /* 无缓存 */ }
    return []
  }
  const items = []
    let curCat = ''
    for (const line of md.split('\n')) {
      const catM = line.match(/^### (.+)/)
      if (catM) { curCat = catM[1].trim(); continue }
      const m = line.match(/^\- \[([^\]]+)\]\(https:\/\/github\.com\/([^)\)]+)\)\s*-\s*(.*)$/)
      if (m) {
        items.push({
          name: m[1],
          repo: m[2].replace(/\/+$/, ''),
          category: curCat,
          desc: m[3].trim(),
        })
      }
    }
  writeFileSync(AWESOME_CACHE, JSON.stringify(items, null, 2))
  return items
}

/** 拉取 AdamPlatin123 自动雷达的验证状态 → Map<repo, status>（✅ 运行级可用 / ⏳ 未测 / ❌ 失败等） */
async function fetchRadarStatus() {
  const url = 'https://raw.githubusercontent.com/AdamPlatin123/awesome-dsh-plugins/main/README.md'
  let md = ''
  try {
    const env = { ...process.env }
    if (loadConfig().proxy) { env.HTTPS_PROXY = loadConfig().proxy; env.HTTP_PROXY = loadConfig().proxy }
    md = await new Promise((resolve, reject) => {
      execFile('curl', ['-sS', '--max-time', '30', url], { encoding: 'utf8', env, windowsHide: true, timeout: 40000 }, (err, stdout, stderr) => {
        if (err || !stdout) return reject(new Error('雷达拉取失败' + (stderr ? '：' + stderr.slice(0, 150) : '')))
        resolve(stdout)
      })
    })
  } catch (e) {
    console.warn('[plugin-store] AdamPlatin123 雷达拉取失败（跳过）:', e.message)
    return new Map()
  }
  // 表格行：| [name](https://github.com/owner/repo) | 社区/官方 | ✅ 运行级可用 | desc |
  const statusByRepo = new Map()
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*\[[^\]]+\]\(https:\/\/github\.com\/([^)\s]+)\)\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|/)
    if (m) {
      const repo = m[1].replace(/\/+$/, '').replace(/#.*$/, '')
      const status = m[2].trim()
      statusByRepo.set(repo.toLowerCase(), status)
    }
  }
  return statusByRepo
}

/** 验证包确实是 dsh 插件（package.json 有 dsh 字段），带 7 天缓存 */
async function verifyDshField(pkgName) {
  const safe = pkgName.replace(/[^a-zA-Z0-9-_@]/g, '_')
  const cacheFile = join(VERIFY_DIR, safe + '.json')
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (Date.now() - c.at < VERIFY_TTL) return { ok: !!c.ok, fromCache: true }
  } catch { /* 无缓存 */ }
  try {
    const enc = encodeURIComponent(pkgName).replace('%40', '@')
    const data = await httpGetJson(`https://registry.npmjs.org/${enc}/latest`, { timeout: 10 })
    const ok = !!data?.dsh
    writeFileSync(cacheFile, JSON.stringify({ ok, at: Date.now() }))
    return { ok, fromCache: false }
  } catch {
    return { ok: true, fromCache: false, uncertain: true } // 网络失败不排除
  }
}

/** 并发受限执行 */
async function runPool(items, worker, size = 5) {
  const results = new Array(items.length)
  let i = 0
  async function runner() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner))
  return results
}

/** 人工钦定的已验证插件（作者可信，跳过网络验证） */
const CURATED_VERIFIED = [
  'dsh-plugin-session-import',
  'dsh-plugin-notify',
  'dsh-store',
  'create-dsh-plugin',
]

let verifyRunning = false
let refreshInFlight = null

/** 后台质量验证：不阻塞首次返回；完成后剔除无 dsh 字段的噪声 */
function startBackgroundVerify(catalog) {
  if (verifyRunning || catalog.verifyComplete) return
  verifyRunning = true
  ;(async () => {
    try {
      const targets = catalog.plugins.filter((p) => p.verified !== true)
      await runPool(targets.slice(0, 200), async (p) => {
        const v = await verifyDshField(p.name)
        p.verified = v.ok
      }, 6)
      const cleaned = catalog.plugins.filter((p) => p.verified !== false)
      const fresh = { generatedAt: catalog.generatedAt, verifyComplete: true, count: cleaned.length, plugins: cleaned }
      writeFileSync(CATALOG_FILE, JSON.stringify(fresh, null, 2))
      console.log(`[plugin-store] 后台验证完成，目录 ${cleaned.length} 个（剔除 ${catalog.plugins.length - cleaned.length} 个噪声）`)
    } catch (e) {
      console.warn('[plugin-store] 后台验证失败:', e.message)
    } finally {
      verifyRunning = false
    }
  })()
}

/** 刷新目录（npm 聚合 + GitHub 星标；验证走后台），写缓存。single-flight 防并发重复拉取 */
function refreshCatalog(force = false) {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      ensureStoreDirs()
      if (!force) {
        try {
          const st = statSync(CATALOG_FILE)
          const cached = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
          if (cached?.plugins?.length && Date.now() - st.mtimeMs < CATALOG_TTL) {
            startBackgroundVerify(cached)
            return cached
          }
        } catch { /* 无缓存或损坏 */ }
      }
      const [npmEntries, ghMap, awesome, radar] = await Promise.all([fetchNpmEntries(), fetchGithubStars(), fetchAwesomeList(), fetchRadarStatus()])

      // awesome 精选索引：repo/name → 分类+描述
      const awesomeByRepo = new Map()
      for (const a of awesome) {
        awesomeByRepo.set(a.repo.toLowerCase(), a)
        awesomeByRepo.set(a.name.toLowerCase(), a)
      }

      // GitHub 星标合并（按包名 / 仓库名匹配）
      for (const e of npmEntries) {
        const key = e.repo.toLowerCase() || e.name.toLowerCase()
        const gh = ghMap.get(key) || ghMap.get(e.name.toLowerCase())
        if (gh) {
          e.stars = gh.stars
          e.repo = e.repo || gh.fullName
          e.updatedAt = gh.updatedAt
          if (!e.description) e.description = gh.description
          if (!e.author) e.author = gh.author
          e.homepage = e.homepage || gh.htmlUrl
        }
        // awesome 精选叠加：分类 + 精选徽章
        const aw = awesomeByRepo.get(key) || awesomeByRepo.get(e.name.toLowerCase())
        if (aw) {
          e.category = aw.category
          e.curated = true
          if (!e.description) e.description = aw.desc
        }
        // AdamPlatin123 雷达验证状态（✅ 运行级可用等）
        const radarStatus = radar.get(key) || radar.get(e.name.toLowerCase())
        if (radarStatus) e.radarStatus = radarStatus
      }

      // awesome 里有但 npm 上搜不到的精选仓库 → 追加为展示条目（可跳 GitHub，标注未上 npm）
      const npmRepoNames = new Set(npmEntries.map((e) => e.repo.toLowerCase()).filter(Boolean))
      const npmPkgNames = new Set(npmEntries.map((e) => e.name.toLowerCase()))
      const extraCurated = []
      for (const a of awesome) {
        const key = a.repo.toLowerCase()
        if (npmRepoNames.has(key) || npmPkgNames.has(a.name.toLowerCase())) continue
        extraCurated.push({
          name: a.name,
          packageName: '',            // 未上 npm，无包名
          version: '',
          description: a.desc,
          author: a.repo.split('/')[0],
          repo: a.repo,
          homepage: `https://github.com/${a.repo}`,
          category: a.category,
          curated: true,
          stars: 0,
          installable: false,          // 未上 npm，不可一键安装
          ...radar.get(key) ? { radarStatus: radar.get(key) } : {},
        })
      }

      // 钦定已验证
      for (const e of npmEntries) {
        if (CURATED_VERIFIED.includes(e.name)) e.verified = true
      }

      const plugins = [...npmEntries, ...extraCurated].sort((a, b) => b.stars - a.stars)
      const catalog = {
        generatedAt: Date.now(),
        verifyComplete: false,
        count: plugins.length,
        curatedCount: extraCurated.length,
        plugins,
      }
      writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2))
      startBackgroundVerify(catalog)
      return catalog
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

function readCatalogCache() {
  try {
    return JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
  } catch {
    return null
  }
}

// ── 安装引擎 ──
/** 解析插件自带的 cordis.patch.yml 里的 insert 行 */
function parseInsertRows(text) {
  const rows = []
  const re = /- id:\s*(\S+)\s*[\r\n]+\s*name:\s*'([^']+)'/g
  let m
  while ((m = re.exec(text))) rows.push({ id: m[1], name: m[2] })
  return rows
}

/** 把一行 insert 合并进 profile patch（id 已存在则跳过） */
function mergeRowIntoPatch(profilePatchText, row) {
  const idRe = new RegExp(`- id:\\s*${row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  if (idRe.test(profilePatchText)) return profilePatchText
  const idx = profilePatchText.indexOf('- insert:')
  if (idx === -1) throw new Error('profile 的 cordis.patch.yml 缺少 "- insert:" 段')
  const lineEnd = profilePatchText.indexOf('\n', idx)
  const insertLine = profilePatchText.slice(idx, lineEnd === -1 ? profilePatchText.length : lineEnd)
  let head, tail
  if (/\[\s*\]/.test(insertLine)) {
    // 空列表内联（- insert: []）→ 转成块结构再插入
    head = profilePatchText.slice(0, idx) + '- insert:\n'
    tail = lineEnd === -1 ? '' : profilePatchText.slice(lineEnd + 1)
  } else {
    head = profilePatchText.slice(0, lineEnd + 1)
    tail = profilePatchText.slice(lineEnd + 1)
  }
  return head + `    - id: ${row.id}\n      name: '${row.name}'\n` + tail
}

function readProfilePatch() {
  const path = join(getProfileDir(), 'cordis.patch.yml')
  if (existsSync(path)) return { path, text: readFileSync(path, 'utf8') }
  return { path, text: '- insert: []\n' }
}

/** 定位 dsh 启动脚本（当前进程 argv[1]，通常 .../dsh/lib/bin.js） */
function dshBinPath() {
  return process.argv[1] || ''
}

/** 官方 dsh plugin 命令：dsh plugin --profile <name> <add|remove> <pkg> */
function runOfficialDshPlugin(args) {
  const bin = dshBinPath()
  if (!/bin\.js/.test(bin)) return { ok: false, reason: '无法定位 dsh bin.js' }
  const profile = loadConfig().profile
  // 显式注入代理（dsh 进程 env 可能没有 HTTPS_PROXY，pnpm 无代理会挂起）
  const env = { ...process.env }
  const proxy = loadConfig().proxy
  if (proxy) {
    if (!env.HTTPS_PROXY) env.HTTPS_PROXY = proxy
    if (!env.HTTP_PROXY) env.HTTP_PROXY = proxy
    if (!env.https_proxy) env.https_proxy = proxy
    if (!env.http_proxy) env.http_proxy = proxy
  }
  const r = spawnSync(process.execPath, [bin, 'plugin', '--profile', profile, ...args], {
    encoding: 'utf8', timeout: 300000, windowsHide: true, env,
  })
  if (r.error) return { ok: false, reason: r.error.message }
  // dsh plugin 转发 pnpm，退出码 0 视为成功（pnpm 11 构建脚本警告也可能非 0，以 bundles 验证为准）
  return { ok: r.status === 0, exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** 执行包管理器命令（手写回退路径）；返回原始结果，成败由调用方按文件系统验证 */
function runPm(args, cwd) {
  const npmArgs = args[0] === 'add'
    ? ['--no-package-lock', 'install', '--save', args[args.length - 1]]
    : ['--no-package-lock', 'uninstall', args[args.length - 1]]
  const candidates = [['pnpm', args], ['npm', npmArgs]]
  let lastErr = ''
  for (const [cmd, realArgs] of candidates) {
    // Windows 下 npm 全局 bin 可能是 .ps1/.cmd shim，统一走 PowerShell 解析
    const cmdline = cmd + ' ' + realArgs.map((a) => (/[\s']/.test(a) ? `'${a.replace(/'/g, "''")}'` : a)).join(' ')
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmdline], {
        cwd, encoding: 'utf8', timeout: 300000, windowsHide: true, env: { ...process.env },
      })
      if (r.error) { lastErr = r.error.message; continue }
      // pnpm 11 装完可能因"未批准构建脚本"返回退出码 1（实际已成功），成败交给调用方验证
      return { cmd, exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
    } catch (e) { lastErr = String(e) }
  }
  throw new Error(`包管理器执行失败: ${lastErr}`)
}

/** 读取 profile 的 dsh.profile.bundles 列表 */
function readProfileBundles() {
  try {
    const pkgJson = JSON.parse(readFileSync(join(getProfileDir(), 'package.json'), 'utf8'))
    return [...(pkgJson.dsh?.profile?.bundles ?? [])]
  } catch {
    return []
  }
}

/** 安装一个插件：优先官方 dsh plugin add（进 bundles 层），失败回退手写 pnpm + patch 合并 */
function installPlugin(entry) {
  const profileDir = getProfileDir()
  if (!existsSync(profileDir)) throw new Error(`profile 目录不存在: ${profileDir}`)

  // 路径 1：官方 dsh plugin add → 自动 reconcile dsh.profile.bundles
  const official = runOfficialDshPlugin(['add', entry.name])
  if (official.ok && readProfileBundles().includes(entry.name)) {
    return { ok: true, name: entry.name, via: 'dsh plugin add', restartRequired: true }
  }

  // 路径 2：手写 pnpm + patch 合并（官方不可用或未生效时回退）
  const r = runPm(['add', entry.name], profileDir)
  const pkgDir = join(profileDir, 'node_modules', entry.name)
  if (!existsSync(join(pkgDir, 'package.json'))) {
    throw new Error(`安装失败（${r.cmd} 退出码 ${r.exitCode}）：${(r.stderr || r.stdout || '').slice(0, 300)}`)
  }
  const pluginPatchPath = join(pkgDir, 'cordis.patch.yml')
  let rows = []
  if (existsSync(pluginPatchPath)) {
    rows = parseInsertRows(readFileSync(pluginPatchPath, 'utf8'))
  }
  if (rows.length === 0) {
    rows = [{ id: entry.name.replace(/^dsh-plugin-/, ''), name: entry.name }]
  }
  const patch = readProfilePatch()
  let text = patch.text
  for (const row of rows) text = mergeRowIntoPatch(text, row)
  writeFileSync(patch.path, text)
  return { ok: true, name: entry.name, rows, restartRequired: true, via: r.cmd }
}

/** 卸载插件：优先官方 dsh plugin remove，失败回退手写；同时清理 patch 残留行 */
function uninstallPlugin(entry) {
  const profileDir = getProfileDir()
  const official = runOfficialDshPlugin(['remove', entry.name])
  if (!official.ok) {
    runPm(['remove', entry.name], profileDir)
  }
  // 无论哪条路径，都清理手写 patch 里的残留行（防重复）
  const patch = readProfilePatch()
  const nameRe = new RegExp(`\\s*- id: [^\\n]*\\n\\s*name: '${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\n?`, 'g')
  const text = patch.text.replace(nameRe, '')
  writeFileSync(patch.path, text)
  return { ok: true, name: entry.name, restartRequired: true, via: official.ok ? 'dsh plugin remove' : 'pnpm' }
}

/** 已安装列表：dsh.profile.bundles + 依赖 + patch 行 三源合并 */
/** 已安装列表：返回 [{ id, name, disabled }]（三源合并 + 停用状态） */
function installedPlugins() {
  const profileDir = getProfileDir()
  const patchText = readProfilePatch().text
  const known = new Map() // name -> { id, name, disabled }
  const add = (id, name) => {
    if (!name || known.has(name)) return
    const idEsc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const disabled = new RegExp('- id:\\s*' + idEsc + '\\b[\\s\\S]*?disabled:\\s*true').test(patchText)
    known.set(name, { id, name, disabled })
  }
  for (const b of readProfileBundles()) {
    if (b.startsWith("@deepseek-ai/")) continue
    add(b.replace(/^dsh-plugin-/, "").replace(/^dsh-/, ""), b)
  }
  try {
    const pkgJson = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"))
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      if ((dep.startsWith("dsh-") || dep.startsWith("@")) && !dep.startsWith("@deepseek-ai/")) {
        add(dep.replace(/^dsh-plugin-/, "").replace(/^dsh-/, ""), dep)
      }
    }
  } catch { /* 无 package.json */ }
  for (const row of parseInsertRows(patchText)) {
    add(row.id, row.name)
  }
  return [...known.values()]
}


/** 读取本地已安装插件的版本（从 profile node_modules） */
function getInstalledVersion(name) {
  try {
    const p = JSON.parse(readFileSync(join(getProfileDir(), 'node_modules', name, 'package.json'), 'utf8'))
    return p.version
  } catch { return undefined }
}

/** 查询 npm registry 最新版本 */
async function getLatestVersion(name) {
  try {
    const data = await httpGetJson('https://registry.npmjs.org/' + encodeURIComponent(name).replace(/%40/g, '@') + '/latest', { timeout: 10 })
    return data.version
  } catch { return undefined }
}

/** 检查已安装插件更新：返回 [{ name, local, latest, updateAvailable }] */
async function checkUpdates() {
  const installed = installedPlugins()
  const results = []
  for (const item of installed) {
    const local = getInstalledVersion(item.name)
    const latest = await getLatestVersion(item.name)
    if (local && latest && local !== latest) {
      results.push({ name: item.name, local, latest, updateAvailable: true })
    } else if (local && latest) {
      results.push({ name: item.name, local, latest, updateAvailable: false })
    }
  }
  return results
}

/** 更新一个插件（复用 installPlugin 的官方 dsh plugin add） */
async function updatePlugin(name) {
  const entry = { name, repo: '', installKind: 'npm' }
  return installPlugin(entry)
}


/** 获取插件 README 摘要（优先本地已安装，其次 npm registry） */
async function getPluginReadme(name) {
  // 1. 本地已安装：profile node_modules 里的 README
  const local = join(getProfileDir(), 'node_modules', name, 'README.md')
  try {
    if (existsSync(local)) {
      const text = readFileSync(local, 'utf8')
      return { source: 'local', text: text.slice(0, 8000) }
    }
  } catch { /* 忽略 */ }
  // 2. npm registry：从 packument 拿 readme（需要 GET 完整包信息）
  try {
    const data = await httpGetJson('https://registry.npmjs.org/' + encodeURIComponent(name).replace(/%40/g, '@'), { timeout: 15 })
    const readme = data.readme || data.versions?.[data['dist-tags']?.latest]?.readme
    if (readme) return { source: 'npm', text: String(readme).slice(0, 8000) }
  } catch { /* 忽略 */ }
  return { source: 'none', text: '' }
}

/** 启用/停用一个已安装插件（写 cordis.patch.yml 的 disabled 标记，HMR 实时生效） */
function togglePlugin(name, enable) {
  const patch = readProfilePatch()
  const patchText = patch.text
  const row = parseInsertRows(patchText).find((r) => r.name === name)
  if (!row) throw new Error("未找到插件 " + name + " 的 patch 条目")
  const idEsc = row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const idRe = new RegExp('- id:\\s*' + idEsc + '\\b')
  const hasDisable = new RegExp('- id:\\s*' + idEsc + '\\b[\\s\\S]*?disabled:\\s*true').test(patchText)
  const lines = patchText.split('\n')
  if (enable && hasDisable) {
    // 启用：删除该条目块内的 disabled: true 行（可能跟在 name 后）
    const out = []
    let inBlock = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (idRe.test(line)) { inBlock = true; out.push(line); continue }
      if (inBlock) {
        // 遇到下一个 - id: 或 - insert: 则退出块
        if (/^\s*- id:/.test(line) || /^\s*- insert:/.test(line)) { inBlock = false; out.push(line); continue }
        // 块内跳过 disabled: true 行
        if (/disabled:\s*true/.test(line)) continue
        out.push(line)
        continue
      }
      out.push(line)
    }
      writeFileSync(patch.path, out.join(String.fromCharCode(10)))
    return { ok: true, name, enabled: true, via: "patch" }
  }
  if (!enable && !hasDisable) {
    // 停用：在该条目块末尾（name 行后）加 disabled: true
    const out = []
    let inBlock = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (idRe.test(line)) { inBlock = true; out.push(line); continue }
      if (inBlock) {
        // 遇到下一个 - id: 或 - insert: → 块结束，先补 disabled 再处理当前行
        if (/^\s*- id:/.test(line) || /^\s*- insert:/.test(line)) {
          out.push("  disabled: true")
          inBlock = false
          out.push(line)
          continue
        }
        // 块内普通行（name 等）正常保留
        out.push(line)
        continue
      }
      out.push(line)
    }
    if (inBlock) out.push("  disabled: true") // 块在文件末尾结束
    writeFileSync(patch.path, out.join(String.fromCharCode(10)))
    return { ok: true, name, enabled: false, via: "patch" }
  }
  return { ok: true, name, enabled: enable, via: "noop" }
}

/** 重启 dsh（独立进程：等 2 秒 → 杀 dsh web → 重新拉起） */
function restartDsh() {
  const bin = process.argv[1] || ''
  if (!/bin\.js/.test(bin)) throw new Error('无法定位 dsh 启动脚本（process.argv[1]）')
  const script = [
    'Start-Sleep -Seconds 2',
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -match \'dsh.*bin\\.js web\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Seconds 1',
    `Start-Process -FilePath "${process.execPath.replace(/"/g, '\\"')}" -ArgumentList '"${bin.replace(/"/g, '\\"')}"','web' -WindowStyle Hidden`,
  ].join('; ')
  spawn('powershell', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore' }).unref()
  return { ok: true, message: '正在重启 dsh，浏览器将在几秒后重连' }
}

// ── 页面 ──
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh 插件商店</title>
<style>
/* 独立页面兜底：dsh 设计变量不在独立页注入，这里补一套暗色值（与主界面 force-dark 一致） */
:root {
  --dsw-alias-bg-base: rgb(21, 21, 23);
  --dsw-alias-label-primary: rgb(249, 250, 251);
  --dsw-alias-label-secondary: rgb(207, 211, 214);
  --dsw-alias-label-tertiary: rgb(173, 178, 184);
  --dsw-alias-border-l2: rgba(255, 255, 255, .12);
  --dsw-alias-bg-module-platform: rgb(53, 54, 56);
  --dsw-alias-bg-layer-2: rgb(44, 44, 46);
  --dsw-alias-bg-mask-3: rgba(0, 0, 0, .48);
  --dsw-alias-button-info-fill: rgb(103, 158, 254);
  --dsw-alias-button-info-hover: rgb(65, 118, 230);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, .08);
  --dsw-alias-interactive-bg-primary: rgba(103, 158, 254, .15);
  --dsw-alias-brand-primary: rgb(249, 250, 251);
  --dsw-alias-state-success-primary: rgb(34, 197, 94);
  --dsw-alias-state-success-tertiary: rgb(35, 60, 44);
  --dsw-alias-state-warn-primary: rgb(245, 158, 11);
  --dsw-alias-state-warn-secondary: rgb(247, 173, 49);
  --dsw-alias-state-error-secondary: rgb(242, 90, 90);
  --dsw-alias-label-error: rgb(242, 90, 90);
  --dsw-alias-label-inverse: #ffffff;
  --dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --dsw-shadow-lv3: 0 0 1px 0 rgba(0, 0, 0, .2), 0 0 4px 0 rgba(0, 0, 0, .02), 0 12px 32px 0 rgba(0, 0, 0, .08);
  color-scheme: dark;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 13px/1.6 var(--dsw-font-family, "Segoe UI", system-ui, sans-serif); }
header { position: sticky; top: 0; z-index: 10; background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l2); padding: 12px 24px;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.logo { display: flex; align-items: center; gap: 8px; }
.logo b { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.logo span { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.search { flex: 1; min-width: 180px; max-width: 360px; background: var(--dsw-alias-bg-module-platform);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 7px 12px;
  color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; }
.search:focus { border-color: var(--dsw-alias-brand-primary); }
.tabs { display: flex; gap: 2px; }
.tab { background: transparent; border: none; color: var(--dsw-alias-label-secondary);
  padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tab.on { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); }
.count { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
main { max-width: 1120px; margin: 0 auto; padding: 20px 24px; }
.banner { background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; color: var(--dsw-alias-label-secondary);
  font-size: 12.5px; display: none; }
.banner.show { display: flex; gap: 10px; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.card { background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; cursor: pointer;
  transition: border-color .12s; }
.card:hover { border-color: var(--dsw-alias-brand-primary); }
.card-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.card-top h3 { font-size: 13.5px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; flex: none; border: 1px solid transparent; }
.badge.verified { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-primary); }
.badge.installed { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-tertiary); }
.badge.curated { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-secondary); }
.badge.nonpm { color: var(--dsw-alias-label-tertiary); border-color: var(--dsw-alias-border-l2); }
.badge.radar { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-tertiary); }
.desc { color: var(--dsw-alias-label-secondary); font-size: 12.5px; min-height: 36px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.meta { display: flex; gap: 10px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; align-items: center; }
.meta .star { color: var(--dsw-alias-state-warn-primary); }
.card-foot { display: flex; gap: 8px; align-items: center; margin-top: 2px; }
.inst-btn { background: var(--dsw-alias-button-info-fill); border: none; color: var(--dsw-alias-label-inverse, #fff);
  border-radius: 6px; padding: 6px 16px; font-size: 12.5px; cursor: pointer; flex: none; }
.inst-btn:hover { background: var(--dsw-alias-button-info-hover); }
.inst-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.inst-btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
.inst-btn.danger { background: transparent; border: 1px solid var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-error); }
.inst-btn.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.inst-btn:disabled { opacity: .5; cursor: wait; }
.status { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.empty { color: var(--dsw-alias-label-tertiary); text-align: center; padding: 60px 0; font-size: 13px; }
.skeleton { background: var(--dsw-alias-bg-layer-2); border-radius: 10px; height: 140px; }
.modal-mask { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-3, rgba(0,0,0,.48)); z-index: 30;
  display: flex; align-items: center; justify-content: center; }
.modal { background: var(--dsw-alias-bg-layer-2, #232324);
  border-radius: 16px; box-shadow: var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.5)); width: 560px; max-width: 92vw;
  max-height: 80vh; display: flex; flex-direction: column; padding: 20px; gap: 10px; }
.modal h2 { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 6px;
  color: var(--dsw-alias-label-primary); }
.modal .desc-full { color: var(--dsw-alias-label-secondary); font-size: 13px; overflow-y: auto; }
.modal a { color: var(--dsw-alias-brand-primary); text-decoration: none; font-size: 12.5px; }
.modal-close { align-self: flex-end; background: transparent; border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
</style>
</head>
<body>
<header>
  <div class="logo"><b>dsh 插件商店</b><span>上游目录 · 一键安装 · 自动 patch</span></div>
  <input class="search" id="q" placeholder="搜索插件名称 / 描述 / 作者…">
  <div class="tabs">
    <button class="tab on" data-sort="stars">星标</button>
    <button class="tab" data-sort="date">最新</button>
    <button class="tab" data-sort="name">名称</button>
  </div>
  <select id="cat" style="background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 10px;font-size:12.5px;outline:none"><option value="">全部分类</option></select>
  <span class="count" id="count"></span>
  <button class="inst-btn ghost" id="refresh">刷新目录</button>
  <button class="inst-btn ghost" id="check-updates">检查更新</button>
</header>
<main>
  <div class="banner" id="banner"></div>
  <div id="update-panel" style="display:none;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;margin-bottom:14px"></div>
  <div class="grid" id="grid"></div>
</main>
<div id="modal-root"></div>
<script>
var $ = function (s) { return document.querySelector(s); };
var state = { plugins: [], q: '', sort: 'stars', cat: '' };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
var CATS = ['UI Enhancements', 'Themes & Appearance', 'Sessions & Messages', 'Memory', 'Tools & Capabilities', 'Skills', 'Workflow & Automation', 'Notifications & Integrations', 'Models & Providers', 'Development & Runtime', 'Just for Fun']
var CAT_ZH = { 'UI Enhancements': '界面增强', 'Themes & Appearance': '主题外观', 'Sessions & Messages': '会话消息', 'Memory': '记忆', 'Tools & Capabilities': '工具能力', 'Skills': '技能', 'Workflow & Automation': '工作流自动化', 'Notifications & Integrations': '通知集成', 'Models & Providers': '模型提供方', 'Development & Runtime': '开发运行时', 'Just for Fun': '整活' }
function catZh(c) { return CAT_ZH[c] || c; }

function banner(msg, isErr) {
  var b = $('#banner');
  b.textContent = msg;
  b.style.borderColor = isErr ? 'var(--bad)' : '';
  b.classList.add('show');
}

function render() {
  var list = state.plugins.filter(function (p) {
    if (state.cat && p.category !== state.cat) return false;
    if (!state.q) return true;
    var q = state.q.toLowerCase();
    return (p.name + ' ' + (p.description || '') + ' ' + (p.author || '') + ' ' + (p.category || '')).toLowerCase().indexOf(q) >= 0;
  });
  if (state.sort === 'stars') list.sort(function (a, b) { return (b.stars || 0) - (a.stars || 0); });
  else if (state.sort === 'date') list.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
  else list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  $('#count').textContent = list.length + ' / ' + state.plugins.length + ' 个插件';
  var g = $('#grid');
  g.innerHTML = '';
  for (var i = 0; i < list.length; i++) (function (p) {
    var card = document.createElement('div');
    card.className = 'card';
    card.onclick = function (e) { if (e.target.tagName === 'BUTTON') return; openModal(p); };
    var verified = p.verified === true;
    var curated = p.curated === true;
    var notNpm = p.installable === false;
    var isInst = p.installed;
    var h = '';
    h += '<div class="card-top"><h3 title="' + esc(p.name) + '">' + esc(p.name) + '</h3>';
    if (curated) h += '<span class="badge curated">精选</span>';
    if (verified) h += '<span class="badge verified">已验证</span>';
    if (isInst) h += '<span class="badge installed">已安装</span>';
    if (notNpm) h += '<span class="badge nonpm">未上 npm</span>';
    if (p.radarStatus && p.radarStatus.indexOf('✅') >= 0) h += '<span class="badge radar">雷达验证</span>';
    h += '</div>';
    h += '<div class="desc">' + esc(p.description || '（无描述）') + '</div>';
    h += '<div class="meta">';
    if (p.category) h += '<span>' + esc(catZh(p.category)) + '</span>';
    h += '<span class="star">★ ' + (p.stars || 0) + '</span><span>' + esc(p.author || '未知作者') + '</span><span>v' + esc(p.version || '?') + '</span></div>';
    h += '<div class="card-foot">';
    if (isInst) {
      if (p.disabled) {
        h += '<button class="inst-btn ghost" data-act="toggle" data-enable="1" data-name="' + esc(p.name) + '">启用</button>';
      } else {
        h += '<button class="inst-btn ghost" data-act="toggle" data-enable="0" data-name="' + esc(p.name) + '">停用</button>';
      }
      h += '<button class="inst-btn danger" data-act="uninstall" data-name="' + esc(p.name) + '">卸载</button>';
    } else if (notNpm) {
      h += '<a class="inst-btn ghost" href="' + esc(p.homepage) + '" target="_blank" style="text-decoration:none">GitHub</a>';
    } else {
      h += '<button class="inst-btn" data-act="install" data-name="' + esc(p.name) + '">安装</button>';
    }
    h += '<span class="status"></span></div>';
    card.innerHTML = h;
    g.appendChild(card);
  })(list[i]);
  var btns = g.querySelectorAll('button[data-act]');
  for (var j = 0; j < btns.length; j++) btns[j].onclick = function (e) {
    e.stopPropagation();
    act(this.getAttribute('data-act'), this.getAttribute('data-name'), this);
  };
  if (list.length === 0) g.innerHTML = '<div class="empty">没有匹配的插件</div>';
}

function openModal(p) {
  var root = $('#modal-root');
  var mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.onclick = function (e) { if (e.target === mask) root.innerHTML = ''; };
  var h = '<div class="modal">';
  h += '<h2>' + esc(p.name) + (p.verified === true ? ' <span class="badge verified">已验证</span>' : '') + (p.curated === true ? ' <span class="badge curated">精选</span>' : '') + '</h2>';
  if (p.category) h += '<div class="meta"><span>' + esc(catZh(p.category)) + '</span></div>';
  h += '<div class="desc-full">' + esc(p.description || '（无描述）') + '</div>';
  h += '<div class="meta"><span class="star">★ ' + (p.stars || 0) + '</span><span>' + esc(p.author || '') + '</span><span>v' + esc(p.version || '?') + '</span><span>' + esc(p.date || '').slice(0, 10) + '</span></div>';
  h += '<div class="readme-box" style="margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;max-height:220px;overflow-y:auto;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap">加载 README…</div>';
  if (p.homepage) h += '<a href="' + esc(p.homepage) + '" target="_blank">' + esc(p.homepage) + '</a>';
  h += '<div class="card-foot">';
  if (p.installed) {
    h += '<button class="inst-btn danger" data-act="uninstall" data-name="' + esc(p.name) + '">卸载</button>';
  } else if (p.installable === false) {
    h += '<a class="inst-btn ghost" href="' + esc(p.homepage) + '" target="_blank" style="text-decoration:none">去 GitHub 查看</a>';
  } else {
    h += '<button class="inst-btn" data-act="install" data-name="' + esc(p.name) + '">安装</button>';
  }
  h += '<span class="status"></span><button class="modal-close" data-act="close">关闭</button></div>';
  h += '<div class="hint" style="color:var(--dim2);font-size:11.5px">' + (p.installable === false ? '该插件未发布 npm，仅 GitHub 精选，需按仓库 README 手动安装。' : '安装后需重启 dsh 生效；卸载同理。重启会中断当前会话连接。') + '</div>';
  h += '</div>';
  mask.innerHTML = h;
  root.innerHTML = '';
  root.appendChild(mask);
  // 异步加载 README 摘要
  (function (name) {
    fetch('/plugin-store/api/readme?name=' + encodeURIComponent(name)).then(function (r) { return r.json(); }).then(function (d) {
      var box = mask.querySelector('.readme-box');
      if (!box) return;
      if (d.text) box.textContent = d.text.slice(0, 3000) + (d.text.length > 3000 ? ' …（已截断）' : '');
      else box.textContent = '（无 README）';
    }).catch(function () {
      var box = mask.querySelector('.readme-box');
      if (box) box.textContent = '（README 加载失败）';
    });
  })(p.name);
  var btns = mask.querySelectorAll('button[data-act]');
  for (var j = 0; j < btns.length; j++) btns[j].onclick = function () {
    var a = this.getAttribute('data-act');
    if (a === 'close') { root.innerHTML = ''; return; }
    act(a, this.getAttribute('data-name'), this);
  };
}

function act(kind, name, btn) {
  if (kind === 'restart') {
    btn.disabled = true;
    fetch('/plugin-store/api/restart', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      banner(d.message || '正在重启…');
      setTimeout(function () { location.reload(); }, 6000);
    }).catch(function (e) { btn.disabled = false; banner('重启失败: ' + e.message, true); });
    return;
  }
  var stat = btn.parentElement.querySelector('.status');
  btn.disabled = true;
  if (kind === 'toggle') {
    var enable = btn.getAttribute('data-enable') === '1';
    stat.textContent = enable ? '启用中…' : '停用中…';
    fetch('/plugin-store/api/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, enable: enable }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
      btn.disabled = false;
      if (!x.ok) { stat.textContent = '失败'; banner(x.d.error || '操作失败', true); return; }
      load(true);
      stat.textContent = '';
      banner((enable ? '已启用 ' : '已停用 ') + name + '。HMR 实时生效，无需重启。');
    }).catch(function (e) { btn.disabled = false; stat.textContent = '失败'; banner(e.message, true); });
    return;
  }
  stat.textContent = kind === 'install' ? '安装中…' : '卸载中…';
  fetch('/plugin-store/api/' + kind, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name }),
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
    btn.disabled = false;
    if (!x.ok) { stat.textContent = '失败'; banner(x.d.error || '操作失败', true); return; }
    load(true);
    stat.textContent = '';
    banner('已' + (kind === 'install' ? '安装 ' : '卸载 ') + name + '。重启 dsh 生效。');
    var restartBtn = document.createElement('button');
    restartBtn.className = 'inst-btn';
    restartBtn.style.marginLeft = '8px';
    restartBtn.textContent = '立即重启';
    restartBtn.setAttribute('data-act', 'restart');
    restartBtn.onclick = function () { act('restart', '', this); };
    var b = $('#banner');
    b.appendChild(restartBtn);
  }).catch(function (e) { btn.disabled = false; stat.textContent = '失败'; banner(e.message, true); });
}

function load(silent) {
  if (!silent) {
    var g = $('#grid');
    g.innerHTML = '';
    for (var i = 0; i < 6; i++) g.appendChild(document.createElement('div')).className = 'skeleton';
  }
  fetch('/plugin-store/api/catalog').then(function (r) { return r.json(); }).then(function (d) {
    state.plugins = d.plugins || [];
    populateCats();
    render();
    if (d.stale) banner('目录是缓存（' + new Date(d.generatedAt).toLocaleString() + '），点击「刷新目录」获取最新', false);
    else if (d.curatedCount) banner('已接入 awesome 精选列表：' + d.curatedCount + ' 个精选（含未上 npm 的 GitHub 精选）', false);
  }).catch(function (e) {
    $('#grid').innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '</div>';
  });
}


function checkUpdates() {
  var panel = $('#update-panel');
  var btn = $('#check-updates');
  btn.disabled = true; btn.textContent = '检查中…';
  panel.style.display = 'block';
  panel.innerHTML = '<div style="color:var(--dsw-alias-label-secondary);font-size:13px">检查中…</div>';
  fetch('/plugin-store/api/updates').then(function (r) { return r.json(); }).then(function (d) {
    var list = (d.updates || []).filter(function (u) { return u.updateAvailable; });
    btn.disabled = false; btn.textContent = '检查更新';
    if (list.length === 0) {
      panel.innerHTML = '<div style="color:var(--dsw-alias-label-secondary);font-size:13px">所有插件都是最新版本 ✓</div>';
      return;
    }
    var h = '<div style="font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:8px">有 ' + list.length + ' 个插件可更新</div>';
    for (var i = 0; i < list.length; i++) (function (u) {
      h += '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l2)">';
      h += '<span style="flex:1;font-size:13px;color:var(--dsw-alias-label-primary)">' + esc(u.name) + '</span>';
      h += '<span style="font-size:12px;color:var(--dsw-alias-label-tertiary)">' + esc(u.local) + ' → ' + esc(u.latest) + '</span>';
      h += '<button class="inst-btn" data-update="' + esc(u.name) + '">更新</button>';
      h += '</div>';
    })(list[i]);
    panel.innerHTML = h;
    var btns = panel.querySelectorAll('button[data-update]');
    for (var j = 0; j < btns.length; j++) btns[j].onclick = function () {
      var name = this.getAttribute('data-update');
      this.disabled = true; this.textContent = '更新中…';
      fetch('/plugin-store/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
        .then(function (r) { return r.json(); }).then(function (x) {
          if (x.error) { alert('更新失败: ' + x.error); this.disabled = false; this.textContent = '更新'; return; }
          checkUpdates();
          banner('已更新 ' + name + '，重启 dsh 生效');
        });
    };
  }).catch(function (e) { btn.disabled = false; btn.textContent = '检查更新'; panel.innerHTML = '<div style="color:var(--dsw-alias-label-error)">检查失败: ' + esc(e.message) + '</div>'; });
}
$('#check-updates').onclick = checkUpdates;

function populateCats() {
  var sel = $('#cat');
  var seen = {};
  var html = '<option value="">全部分类</option>';
  for (var i = 0; i < state.plugins.length; i++) {
    var c = state.plugins[i].category;
    if (!c || seen[c]) continue;
    seen[c] = 1;
    html += '<option value="' + esc(c) + '">' + esc(catZh(c)) + '</option>';
  }
  var prev = sel.value;
  sel.innerHTML = html;
  sel.value = prev || '';
}

$('#q').oninput = function () { state.q = this.value; render(); };
$('#cat').onchange = function () { state.cat = this.value; render(); };
$('#refresh').onclick = function () {
  var b = $('#refresh'); b.disabled = true; b.textContent = '刷新中…';
  fetch('/plugin-store/api/refresh', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
    state.plugins = d.plugins || [];
    populateCats();
    render();
    banner('目录已更新，共 ' + (d.count || 0) + ' 个插件（含精选 ' + (d.curatedCount || 0) + '）');
  }).catch(function (e) { banner('刷新失败: ' + e.message, true); }).finally(function () { b.disabled = false; b.textContent = '刷新目录'; });
};
var tabs = document.querySelectorAll('.tab');
for (var t = 0; t < tabs.length; t++) tabs[t].onclick = function () {
  for (var k = 0; k < tabs.length; k++) tabs[k].classList.remove('on');
  this.classList.add('on');
  state.sort = this.getAttribute('data-sort');
  render();
};
load(false);
</script>
</body>
</html>`

// ── HTTP 响应辅助 ──
function sendHtml(res, text) {
  const data = Buffer.from(text, 'utf8')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': data.length })
  res.end(data)
}
function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
  res.end(data)
}
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

// ── 插件入口 ──
export function apply(ctx) {
  ensureStoreDirs()

  // 目录带已安装状态
  function catalogWithInstalled(catalog) {
      const installedNames = new Set(installedPlugins().map((i) => i.name))
      const disabledMap = new Map(installedPlugins().filter((i) => i.disabled).map((i) => [i.name, true]))
    return {
      ...catalog,
        plugins: (catalog?.plugins ?? []).map((p) => ({ ...p, installed: installedNames.has(p.name), disabled: disabledMap.has(p.name) })),
    }
  }

  // 后台预热：缓存缺失/过期时异步刷新（首次访问不必干等）
  ;(async () => {
    try {
      const cached = readCatalogCache()
      if (!cached?.plugins?.length) await refreshCatalog()
    } catch (e) { console.warn('[plugin-store] 后台预热失败:', e.message) }
  })()

  // 页面
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store',
    handler: (req, res) => sendHtml(res, PAGE),
  })

  // 目录 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/catalog',
    handler: async (req, res) => {
      try {
        let catalog = readCatalogCache()
        let stale = true
        if (catalog?.plugins?.length) {
          try {
            stale = Date.now() - statSync(CATALOG_FILE).mtimeMs > CATALOG_TTL
          } catch { stale = true }
          startBackgroundVerify(catalog)
        }
        if (!catalog?.plugins?.length) {
          catalog = await refreshCatalog()
          stale = false
        }
        sendJson(res, 200, catalogWithInstalled({ ...catalog, stale }))
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 刷新 API（强制重新拉取）
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/refresh',
    handler: async (req, res) => {
      try {
        const catalog = await refreshCatalog(true)
        sendJson(res, 200, catalogWithInstalled(catalog))
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 安装 / 卸载 API
  for (const kind of ['install', 'uninstall']) {
    ctx.webServer.register({
      kind: 'exact',
      path: `/plugin-store/api/${kind}`,
      handler: async (req, res) => {
        try {
          const body = await readBody(req).catch(() => ({}))
          const entryName = String(body.name ?? '').trim()
          if (!entryName) { sendJson(res, 400, { error: '缺少插件名' }); return }
          const catalog = readCatalogCache()
          const entry = catalog?.plugins?.find((p) => p.name === entryName || p.packageName === entryName)
            ?? { name: entryName, repo: '', installKind: 'npm' }
          // 未上 npm 的精选条目（installable:false）不可一键安装
          if (kind === 'install' && entry.installable === false) {
            sendJson(res, 400, { error: `该插件未发布 npm（仅 GitHub 精选），请到 ${entry.homepage} 按 README 手动安装` })
            return
          }
          const result = kind === 'install' ? installPlugin(entry) : uninstallPlugin(entry)
          sendJson(res, 200, result)
        } catch (e) {
          sendJson(res, 500, { error: e.message })
        }
      },
    })
  }

  // 已安装列表 API（含停用状态）
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/installed',
    handler: async (req, res) => {
      try {
        sendJson(res, 200, { installed: installedPlugins() })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 启用/停用 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/toggle',
    handler: async (req, res) => {
      try {
        const body = await readBody(req).catch(() => ({}))
        const name = String(body.name ?? '').trim()
        const enable = body.enable !== false
        if (!name) { sendJson(res, 400, { error: '缺少插件名' }); return }
        const result = togglePlugin(name, enable)
        sendJson(res, 200, result)
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 更新检查 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/updates',
    handler: async (req, res) => {
      try {
        const updates = await checkUpdates()
        sendJson(res, 200, { updates })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 更新插件 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/update',
    handler: async (req, res) => {
      try {
        const body = await readBody(req).catch(() => ({}))
        const name = String(body.name ?? '').trim()
        if (!name) { sendJson(res, 400, { error: '缺少插件名' }); return }
        const result = await updatePlugin(name)
        sendJson(res, 200, result)
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 插件 README API
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/readme',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const name = url.searchParams.get('name') || ''
        if (!name) { sendJson(res, 400, { error: '缺少插件名' }); return }
        const result = await getPluginReadme(name)
        sendJson(res, 200, result)
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 重启 API
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-store/api/restart',
    handler: async (req, res) => {
      try {
        sendJson(res, 200, restartDsh())
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
  })

  // 命令：/plugin-store 摘要
  ctx.commands.register({
    name: 'plugin-store',
    description: '打开 dsh 插件商店（目录 / 安装 / 卸载）。/plugin-store 看摘要；/plugin-install <包名> 直接安装',
    input: { hint: '（无参数看摘要；或用 /plugin-install）' },
    handler: async () => {
      try {
        const catalog = readCatalogCache()
        const installed = installedPlugins().map((i) => i.name)
        const lines = [
          `dsh 插件商店：http://127.0.0.1:3080/plugin-store`,
          `已收录 ${catalog?.plugins?.length ?? '（目录未生成，访问页面自动拉取）'} 个插件，已安装 ${installed.length} 个`,
        ]
        if (installed.length) lines.push('已安装：' + installed.join('、'))
        const top = (catalog?.plugins ?? []).slice(0, 5).map((p) => `★${p.stars} ${p.name} — ${(p.description ?? '').slice(0, 50)}`)
        if (top.length) lines.push('热门：\n' + top.join('\n'))
        return { kind: 'success', text: lines.join('\n') }
      } catch (e) {
        return { kind: 'error', text: `[plugin-store] ${e.message}` }
      }
    },
  })

  // 命令：/plugin-install <名称>
  ctx.commands.register({
    name: 'plugin-install',
    description: '从商店安装插件：/plugin-install <包名>（会自动改 cordis.patch.yml，装完重启 dsh 生效）',
    input: { hint: '<包名>' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim()
      const name = raw.split(/\s+/)[0]
      if (!name) return { kind: 'error', text: '用法：/plugin-install <包名>，如 /plugin-install dsh-plugin-notify' }
      try {
        const r = installPlugin({ name })
        return { kind: 'success', text: `已安装 ${name}（${r.pm}），patch 已合并：${r.rows.map((x) => x.id).join('、')}。重启 dsh 生效。` }
      } catch (e) {
        return { kind: 'error', text: `[plugin-install] ${e.message}` }
      }
    },
  })
}
