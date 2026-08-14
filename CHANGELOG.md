# Changelog

## [0.4.1] - 2026-08-14

### Fixed
- awesome 拉取 raw CDN 未同步时回退 GitHub API（实时源），解决合并后商店看不到新条目
- 官方安装路径显式注入代理（pnpm 无代理会挂起）

## [0.4.0] - 2026-08-14

### Changed
- README 重写：差异化对比表、官方安装、awesome 数据源、架构更新

## [0.3.1] - 2026-08-14

### Fixed
- 官方安装路径显式注入代理

## [0.3.0] - 2026-08-14

### Added
- 安装引擎改用官方 `dsh plugin add/remove`（dsh.profile.bundles 层），失败回退手写路径
- 已安装识别三源合并（bundles + dependencies + patch）

## [0.2.0] - 2026-08-14

### Added
- client 端原生入口：侧边栏「插件商店」按钮 + 设置页分区

## [0.1.0] - 2026-08-14

### Added
- 初始版本：npm 权威源 + awesome 精选 + GitHub 星标聚合目录
- dsh 字段质量验证（后台剔除噪声）
- 一键安装/卸载（手写 pnpm + patch 合并）
- 分类筛选、搜索、排序、详情
