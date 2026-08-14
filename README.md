# dsh-store

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> 已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表（Development & Runtime）

DeepSeek Harness 插件商店：**上游基础设施**。聚合 npm registry + awesome 精选 + GitHub 星标的 dsh 插件目录，质量验证 + 分类 + 星标排序，在 dsh 内一键安装 / 卸载（走官方 `dsh plugin add/remove`），装完重启即生效。

## 与社区其他商店的差异

| 能力 | dsh-store | 社区其他商店（dsh-market / plugin-hub / workshop 等） |
|---|---|---|
| 数据源 | **npm registry 权威源**（插件实际安装处）+ awesome 精选 + GitHub 星标 | 多为 GitHub topic / awesome 目录（二手源、含蹭话题噪声） |
| 质量验证 | **`dsh` 字段后台验证**，自动剔除噪声（250→222 实测） | 无 |
| 安装 | **官方 `dsh plugin add/remove`**（`dsh.profile.bundles` 层，与命令行等价），失败自动回退 pnpm + patch | 多为 clone / 手改 patch |
| 可安装性 | 目录里每个 npm 条目**都能真的装上** | GitHub-only 列表装上即报错 |
| 已安装识别 | 三源合并（bundles + dependencies + patch） | 大多无 |
| 客户端 | 侧边栏按钮 + 设置页分区 + 完整页面 | 部分有设置页 |

## 功能

- **聚合目录**：npm registry 关键词精确搜索（`keywords:dsh-plugin`）+ awesome-dsh-plugin 精选（324 个，11 分类）+ GitHub 星标合并，550+ 插件
- **精选叠加**：awesome 人工精选插件打「精选」徽章 + 分类；未上 npm 的精选显示 GitHub 跳转
- **质量过滤**：后台验证每个包的 `package.json` 是否有 `dsh` 字段（真插件标记），剔除噪声
- **一键安装**：官方 `dsh plugin add`（自动 reconcile `dsh.profile.bundles`），失败回退 `pnpm add` + patch 合并
- **一键卸载**：官方 `dsh plugin remove`，自动清理 patch 残留
- **一键重启**：装完直接重启 dsh 生效
- **已安装标记**：目录里每个插件显示「已安装 / 可安装」
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
      name: 'dsh-store'
```

或者官方命令：`dsh plugin --profile web add dsh-store`。

重启 dsh，打开 `http://<dsh地址>:<端口>/plugin-store`。

## 使用

- **浏览**：搜索 / 分类筛选 / 按星标·最新·名称排序，卡片显示精选徽章、描述、作者、版本、星标
- **安装**：点「安装」→ 官方 `dsh plugin add` → 点「立即重启」生效
- **详情**：点卡片看完整描述、分类与仓库链接；未上 npm 的精选跳 GitHub
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
| `registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin` | 插件清单（权威，可安装） |
| `awesome-dsh-plugin` 精选列表 | 分类 + 精选徽章（324 个，人工审核） |
| `api.github.com/search/repositories?q=topic:dsh-plugin` | 星标 / 仓库 / 更新信息合并 |
| `AdamPlatin123/awesome-dsh-plugins` 雷达 | 运行级验证状态（✅ 运行级可用等，194+ 条目） |

**质量验证**：安装前后台逐个 GET 每个包的 `/latest` 检查 `dsh` 字段（缓存 7 天），无该字段的剔除——npm 关键词搜索会混入蹭关键词的包，这个过滤保证目录里都是真插件。

## 架构

```
┌─ dsh-store ─────────────────────────────────────────────┐
│ host：catalog 引擎（npm + awesome + 雷达 + GitHub → 合并 → 验证 → 缓存）│
│       安装引擎（官方 dsh plugin add/remove → 回退 pnpm + patch）│
│       API：/plugin-store/api/{catalog,refresh,install,uninstall,restart} │
│ client：侧边栏「插件商店」按钮 + 设置页分区（--dsw-* 变量） │
└────────────────────────────────────────────────────────┘
```

无外部运行时依赖（curl 为 Windows 自带；pnpm 走 PowerShell shim 解析；官方 dsh plugin 路径自动注入代理）。

## 开发

```bash
npm run build      # esbuild 构建 lib/index.js + lib/client.js
node test-mock.mjs # mock + 集成测试（隔离 profile，真实 pnpm 安装/卸载，21 项）
```

## 许可

MIT
