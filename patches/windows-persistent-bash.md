# Windows persistent-bash 修复补丁（dsh 本地）

## 背景
dsh 的 minimal preset 在 Windows 上无法使用 persistent `bash` 工具，报两个错误：
1. `subprocess-local: terminal inspection is unsupported on platform win32`
2. `File not found`（shellPath 默认 `/bin/bash` 在 Windows 不存在）

## 根因（dsh 源码）
- `packages/subprocess/subprocess-local/src/process-inspector.ts` 的 `createProcessInspector()` 只支持 linux/darwin，win32 直接 throw
- `packages/terminal/terminal-bash/src/config.ts` 的 `shellPath` 默认 `/bin/bash`

## 本地修复（node_modules，重装 dsh 后需重新应用）
修改两个文件：

### 1. `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js`
在 `createProcessInspector` 前加 `WindowsProcessInspector` 类，并在函数里加 win32 分支：
```js
var WindowsProcessInspector = class extends PosixProcessInspector {
  foregroundPgid(_shellPid) { return void 0; }
  isStdinWaiting(_pgid) { return false; }
  processTree(rootPid) { return [{ pid: rootPid, started: "" }]; }
  processSession(_sessionId) { return []; }
  isAlive(identity) { return true; }
};
// createProcessInspector 里加：
if (platform === "win32") return new WindowsProcessInspector(internals);
```

### 2. `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js`
把 `shellPath` 默认值改为平台自适应：
```js
shellPath: z.string().default(process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash"),
```

## 说明
- Windows inspector 是保守最小实现：无前台进程组检测/无 stdin-wait 检查，但终端可用
- `isAlive` 保守返回 true（不做 Windows 进程表枚举）
- 官方暂不接受外部 PR（deepseek-ai/deepseek-harness pulls API 404）
