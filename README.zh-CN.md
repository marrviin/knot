# 🐋 Knot

[English](README.md) | **简体中文**

面向多智能体（Multi-Agent）串行工作流的**事件驱动型本地共享内存总线**（Electron 桌面应用，记忆管理基于 [mem0](https://github.com/mem0ai/mem0)）。

设计与规划详见 [docs/design.md](docs/design.md)。

## 工作原理

```
自研 Agent --低频覆写--> .myagent/mem.json
                              │ 后台 chokidar 监听（防抖 500ms）
                              ▼
   Knot 桌面端：mem0 提炼管线（事实提取 → 语义去重 → 冲突裁决）
                + SQLite 镜像存储 + 白盒卡片看板
                              │ --mcp-server（Stdio JSON-RPC）
                              ▼
        Claude Code --MCP 工具 fetch_project_knot--> 拉取共享记忆
```

- **输入端**：chokidar 监听各登记项目的 `.myagent/mem.json` 变更，原始文本交给 mem0
  提炼入库（事实提取、语义去重、新旧冲突裁决）。LLM 用 MiniMax 系列（用户自配 API Key，
  可关闭，关闭时新记忆不会自动洗入）；embedding 用 MiniMax embo-01，经本地转换层适配。
- **存储**：mem0 自带 SQLite 向量库（`<userData>/mem0/vectors.db`）为记忆真相源；
  `knot.db` 镜像表供 UI 卡片与 MCP 关键词检索使用，两者以 memory uuid 关联。
- **输出端**：以 `--mcp-server` 模式运行时，本进程即一个 Stdio MCP Server，
  提供 `fetch_project_knot` / `list_knot_projects` 工具。
- **看板**：白盒 Fact 卡片，支持人工增删改（人工操作同步写回 mem0），防 Agent 间记忆脑裂。

## 开发

```bash
pnpm install
pnpm dev           # 开发调试（自动完成 better-sqlite3 的 Electron ABI 重建）
pnpm build         # 构建产物
pnpm rebuild:electron  # 单独执行 better-sqlite3 的 Electron ABI 重建
```

要求：Node ≥ 20（pnpm）。打包发布用 electron-builder（未配置，后续迭代）。

注意：若终端环境带有 `ELECTRON_RUN_AS_NODE=1`（VS Code 集成终端常见），
需 `env -u ELECTRON_RUN_AS_NODE` 启动；注入 Claude Code 的 MCP 配置已内置
shell 包装自动 unset 该变量。

## 使用

1. 把项目目录拖进窗口（或点「添加项目」），Knot 开始监听该目录下的 `.myagent/mem.json`；
2. 在「提炼层设置」里填入 MiniMax API Key 并启用 LLM 提炼；
3. 点击「激活 Claude Code 记忆」，Knot 会把自己注册进 `~/.claude.json` 的 `mcpServers`（写入前自动备份）；
4. 重启 Claude Code，新任务开始时调用 `fetch_project_knot` 即可拉取前任 Agent 沉淀的记忆。

## 自研 Agent 写入格式

`.myagent/mem.json` 支持任意合理 JSON 结构或纯文本，LLM 会自行提炼硬核事实：

```json
["本项目强制使用 pnpm", "禁止使用 dynamic import"]
```

```json
{ "facts": [{ "content": "打包报错已通过修改 vite.config.js 代理解决" }] }
```
