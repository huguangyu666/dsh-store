# dsh-plugin-store

DeepSeek Harness 插件商店：**上游基础设施**。聚合 npm registry + GitHub 上的 dsh 插件，质量验证 + 星标排序，在 dsh 内一键安装 / 卸载（自动改 `cordis.patch.yml`），装完重启即生效。

## 功能

- **聚合目录**：npm registry 关键词精确搜索（`keywords:dsh-plugin`）+ GitHub `dsh-plugin` topic 星标合并，250+ 插件
- **质量过滤**：后台验证每个包的 `package.json` 是否有 `dsh` 字段（真插件标记），剔除噪声；人工钦定「已验证」徽章
- **一键安装**：`pnpm add`（自动回退 npm）+ **读取插件自带的 `cordis.patch.yml` 合并进 profile patch**（不硬编码 id）
- **一键卸载**：`pnpm remove` + 自动清理 patch 行
- **一键重启**：装完直接重启 dsh 生效（独立进程，断连后自动重连）
- **已安装标记**：目录里每个插件显示「已安装 / 可安装」
- **命令**：`/plugin-store`（摘要）、`/plugin-install <包名>`（直接安装）

## 安装

```bash
npm i dsh-plugin-store
```

profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: plugin-store
      name: 'dsh-plugin-store'
```

重启 dsh，打开 `http://<dsh地址>:<端口>/plugin-store`。

## 使用

- **浏览**：搜索 / 按星标·最新·名称排序，卡片显示描述、作者、版本、星标
- **安装**：点「安装」→ 自动 `pnpm add` + 合并 patch → 点「立即重启」生效
- **详情**：点卡片看完整描述与仓库链接
- **命令行**：`/plugin-install dsh-plugin-xxx`

### 配置

`~/.dsh/plugin-store/config.json`：

```json
{ "proxy": "http://127.0.0.1:7892", "profile": "web" }
```

| 字段 | 说明 |
|---|---|
| `proxy` | GitHub API 代理（国内环境需要）；环境变量 `DSH_PLUGIN_STORE_PROXY` 可覆盖 |
| `profile` | 安装目标 profile（默认 `web`）；环境变量 `DSH_PLUGIN_STORE_PROFILE` 可覆盖 |

目录缓存 24h（`~/.dsh/plugin-store/catalog.json`），页面「刷新目录」强制更新。

## 数据源与质量

| 源 | 用途 |
|---|---|
| `registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin` | 插件清单（权威） |
| `api.github.com/search/repositories?q=topic:dsh-plugin` | 星标 / 仓库 / 更新信息合并 |

**质量验证**：安装前后台逐个 GET 每个包的 `/latest` 检查 `dsh` 字段（缓存 7 天），无该字段的剔除——npm 关键词搜索会混入蹭关键词的包，这个过滤保证目录里都是真插件。

## 架构

```
┌─ dsh-plugin-store (host) ──────────────────────────────┐
│ catalog 引擎：npm + GitHub → 合并 → 后台验证 → 缓存      │
│ 安装引擎：pnpm add → 读插件自带 patch → 合并 profile patch│
│ API：/plugin-store/api/{catalog,refresh,install,uninstall,restart} │
│ 页面：/plugin-store（dsw 设计系统变量，明暗自适应）        │
└────────────────────────────────────────────────────────┘
```

无 client bundle，纯 host + 内嵌页面；无外部运行时依赖（curl 为 Windows 自带，pnpm/npm 走 PowerShell shim 解析）。

## 开发

```bash
npm run build      # esbuild 构建 lib/index.js
node test-mock.mjs # mock + 集成测试（隔离 profile store-test，真实 pnpm 安装/卸载）
```

## 许可

MIT
