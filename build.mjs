/**
 * 构建脚本：生成 lib/ 发布产物（本地 esbuild，不经 npx 子进程）。
 * - lib/index.js  host 端（ESM bundle，商店页面内嵌）
 * - lib/client.js  client bundle（CJS + __ModuleLoader__ 包装）
 */
import * as esbuild from 'esbuild'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

const ID = 'dsh-store'
rmSync('lib', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })

// 1. host 端：ESM bundle
await esbuild.build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['node:fs', 'node:path', 'node:url', 'node:child_process', '@deepseek-ai/*'],
  outfile: 'lib/index.js',
})

// 2. client bundle：CJS + load 包装（官方格式）
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
const footer = `return module.exports; } });`
await esbuild.build({
  entryPoints: ['src/client-source.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  outfile: 'lib/client.js',
})

// 3. 校验产物
const host = readFileSync('lib/index.js', 'utf8')
const client = readFileSync('lib/client.js', 'utf8')
if (!host.includes('dsh-store')) throw new Error('host bundle 缺关键符号')
if (!host.includes('plugin-store/api/catalog')) throw new Error('host bundle 缺 API 路由')
if (!host.includes('keywords:dsh-plugin')) throw new Error('host bundle 缺目录数据源')
if (!client.includes('__ModuleLoader__.load')) throw new Error('client bundle 缺 load 包装')
if (!client.includes('sidebar.footer.action')) throw new Error('client bundle 缺侧边栏入口')
console.log('构建完成：lib/index.js + lib/client.js')
console.log('host:', host.length, 'bytes | client:', client.length, 'bytes')
