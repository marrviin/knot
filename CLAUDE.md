# Knot — 本地记忆看板

Electron + mem0ai 的本地 Agent 记忆管理应用：监听各 Agent（Claude Code 等）的记忆文件，
经 mem0 提炼入库，提供看板浏览、语义检索和 MCP 注入。

## 结构

- `electron/` — 主进程：main（窗口/启动）、ipc、watcher（chokidar 文件监听）、
  ingest、mem0（记忆真相源，自带 SQLite 向量库）、store（knot.db 镜像，供 UI/MCP 关键词检索）、
  settings、discover（自动发现 Claude Code 项目）、inject、mcp-server、embedding-shim
- `src/` — React 渲染层（antd），api.ts 经 window.knot IPC 调主进程
- `src-tauri/` — 已废弃的 Tauri 版本，保留作回滚，确认稳定后删除

## 常用命令

- 开发：`npm run dev`
- 类型检查：`npx tsc --noEmit`
- MCP 模式：`electron . --mcp-server`（注入配置经 /bin/sh 包装 unset ELECTRON_RUN_AS_NODE）

## 关键约定

- 时间戳：数据库（knot.db）存秒级时间戳（store.now()），`rowToFact` 出库时统一 ×1000 转毫秒给 UI
- 监听卡片：`DEFAULT_WATCH_RULES` 内置 claude-code / codex / hermes / joycode；
  卡片 match 支持通配符与 `<slug>` 占位符；MEMORY.md 索引文件不入库
- mem0 配置：MiniMax LLM（M2.7/M3）+ embo-01 embedding（经 embedding-shim），
  向量库持久化在 userData，无需 Qdrant
