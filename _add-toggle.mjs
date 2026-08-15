import { readFileSync, writeFileSync } from 'node:fs'
let s = readFileSync('src/index.js', 'utf8')

// 1. 增强 installedPlugins：返回 [{ id, name, disabled }] 详细列表
const oldInstalled = `function installedPlugins() {
  const profileDir = getProfileDir()
  const installed = []
  // 源 1：dsh.profile.bundles（官方 dsh plugin add 路径）
  for (const b of readProfileBundles()) {
    if (!installed.includes(b)) installed.push(b)
  }
  // 源 2：package.json dependencies（手写 pnpm 路径）
  try {
    const pkgJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      if ((dep.startsWith('dsh-') || dep.startsWith('@')) && !installed.includes(dep)) installed.push(dep)
    }
  } catch { /* 无 package.json */ }
  // 源 3：patch 行（纯 cordis.patch.yml insert 路径）
  const rows = parseInsertRows(readProfilePatch().text)
  for (const row of rows) {
    if (!installed.includes(row.name)) installed.push(row.name)
  }
  return installed
}`

const newInstalled = `/** 已安装列表：返回 [{ id, name, disabled }]（三源合并 + 停用状态） */
function installedPlugins() {
  const profileDir = getProfileDir()
  const patch = readProfilePatch()
  const patchText = patch.text
  // 收集所有已知插件条目（bundles + dependencies + patch insert）
  const known = new Map() // name -> { id, name, disabled }
  const add = (id, name) => {
    if (!name || known.has(name)) return
    // 检查是否被 patch 停用：- id: X 后跟 disabled: true
    const disabled = new RegExp(`- id:\\s*${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\\\b[\\\\s\\\\S]*?disabled:\\\\s*true`).test(patchText)
    known.set(name, { id, name, disabled })
  }
  // 源 1：bundles（id 从包名推导）
  for (const b of readProfileBundles()) {
    if (b.startsWith('@deepseek-ai/')) continue // 官方内置不算用户插件
    add(b.replace(/^dsh-plugin-/, '').replace(/^dsh-/, ''), b)
  }
  // 源 2：dependencies
  try {
    const pkgJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
      if ((dep.startsWith('dsh-') || dep.startsWith('@')) && !dep.startsWith('@deepseek-ai/')) {
        add(dep.replace(/^dsh-plugin-/, '').replace(/^dsh-/, ''), dep)
      }
    }
  } catch { /* 无 package.json */ }
  // 源 3：patch insert 行（带权威 id）
  for (const row of parseInsertRows(patchText)) {
    add(row.id, row.name)
  }
  return [...known.values()]
}

/** 启用/停用一个已安装插件（写 cordis.patch.yml 的 disabled 标记，HMR 实时生效） */
function togglePlugin(name, enable) {
  const patch = readProfilePatch()
  const patchText = patch.text
  // 找到该插件对应的 patch 行（id + name）
  const row = parseInsertRows(patchText).find((r) => r.name === name)
  if (!row) throw new Error(\`未找到插件 ${name} 的 patch 条目\`)
  const idRe = new RegExp(\`- id:\\\\s*\${row.id.replace(/[.*+?^\${}()|[\\\\]\\\\\\\\]/g, '\\\\\\\\$&')}\\\\b\`)
  // 已有该条目的 disabled 标记
  const hasDisable = new RegExp(\`- id:\\\\s*\${row.id.replace(/[.*+?^\${}()|[\\\\]\\\\\\\\]/g, '\\\\\\\\$&')}\\\\b[\\\\s\\\\S]*?disabled:\\\\s*true\`).test(patchText)
  if (enable && hasDisable) {
    // 启用：移除该条目的 disabled: true 行
    const lines = patchText.split('\\n')
    const out = []
    let skipNext = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (skipNext) { skipNext = false; continue }
      if (idRe.test(line)) {
        out.push(line)
        // 跳过紧随的 disabled: true 行
        const next = lines[i + 1]
        if (next && /disabled:\\s*true/.test(next)) { skipNext = true }
        continue
      }
      out.push(line)
    }
    writeFileSync(patch.path, out.join('\\n'))
    return { ok: true, name, enabled: true, via: 'patch' }
  }
  if (!enable && !hasDisable) {
    // 停用：在该条目后追加 disabled: true
    const lines = patchText.split('\\n')
    const out = []
    for (const line of lines) {
      out.push(line)
      if (idRe.test(line)) out.push('  disabled: true')
    }
    writeFileSync(patch.path, out.join('\\n'))
    return { ok: true, name, enabled: false, via: 'patch' }
  }
  return { ok: true, name, enabled: enable, via: 'noop' }
}`

if (!s.includes(oldInstalled)) { console.error('installedPlugins 未匹配'); process.exit(1) }
s = s.replace(oldInstalled, newInstalled)
writeFileSync('src/index.js', s)
console.log('host 端 toggle 函数已添加')
