/**
 * 构建脚本：生成 lib/index.js（host 端 ESM bundle，商店页面内嵌）。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

rmSync('lib', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })

execSync(
  `npx esbuild src/index.js --bundle --format=esm --platform=node --target=es2022 ` +
  `--external:node:fs --external:node:path --external:node:url --external:node:child_process --external:@deepseek-ai/* ` +
  `--outfile=lib/index.js`,
  { stdio: 'inherit' })

const host = readFileSync('lib/index.js', 'utf8')
if (!host.includes('dsh-plugin-store')) throw new Error('host bundle 缺关键符号')
if (!host.includes('plugin-store/api/catalog')) throw new Error('host bundle 缺 API 路由')
if (!host.includes('keywords:dsh-plugin')) throw new Error('host bundle 缺目录数据源')
console.log('构建完成：lib/index.js')
console.log('host:', host.length, 'bytes')
