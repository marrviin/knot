# 🐋 Journal 项目设计方案（Journal Project Design）

## 一、项目概述

**Journal** 是一款面向多智能体（Multi-Agent）串行工作流的**事件驱动型本地共享内存总线**（桌面端应用）。

本方案专为多个 Agent（如自研 Agent 与 Claude Code）在**同一工作目录**下**低频、串行、交替运行**的场景打造。

### 1.1 要解决的问题

传统中央记忆库方案要求每个 Agent 主动调用工具去同步记忆，形成“双重记忆”人格，极易导致：

- **脑裂冲突**：不同 Agent 对同一记忆各持一份、互相覆盖；
- **Token 垃圾爆炸**：大段聊天 Log 被反复搬运、注入上下文。

### 1.2 核心解法

通过 **「后台异步监听（输入）+ 静态 MCP Tool 供给（输出）」的黑盒外挂模式**，实现异构 Agent 之间**零污染、低代价**的记忆无缝接力：

- 输入端：自研 Agent 只需按自己的原生习惯写记忆文件，Journal 在后台静默捕获；
- 输出端：Claude Code 等三方工具通过标准 MCP 接口被动检索，无需任何源码适配。

记忆数据 **100% 留存本地**；核心提炼层（事实提炼 / 语义去重 / 冲突裁决）默认按内置规则离线运行，用户可在设置中配置 OpenAI 兼容 LLM（自持 API Key）以启用智能提炼，届时仅提炼过程调用外部服务。

---

## 二、核心架构设计（Core Architecture）

Journal 以 **Electron 桌面应用**为中央主服务核心，后台常驻 chokidar 文件监听，记忆管理真正引入 **mem0ai（Mem0 官方 Node SDK）**，并通过标准的 MCP（Model Context Protocol）服务端通信协议对外供给。

### 2.1 架构总览

```
  [ 自研 Agent ] (串行开发)
       │ (任务结束, 低频覆写)
       ▼
   💾 自研原生记忆文件 (.myagent/mem.json)
       │
       │ (1. Node.js 后台 Chokidar 异步零感捕获变动)
       ▼
 ┌───────────────────────  🐋 Journal 桌面端应用主服务  ───────────────────────┐
 │                                                                       │
 │  🧠 核心提炼层 (基于 Mem0 原理)：提取硬核技术决策、SOP，自动智能去重   │
 │                                                                       │
 │  🖥️ 前端 UI 层：白盒化、可视化的“绳结(Fact)”卡片看板，支持人工校准介入   │
 │                                                                       │
 └──────────────────────────────────┬────────────────────────────────────┘
                                    │ (2. 挂载为标准的本地进程间 MCP Tool)
                                    ▼
                            [ Claude Code ] (新任务启动时, 被动按需 Request 检索)
```

### 2.2 输入端：异步事件驱动监听（Event-Driven Watcher）

自研 Agent 在本地流水线结束时，将**最终的高纯度硬核结论**（而非大段聊天 Log 垃圾）写入它原生的本地记忆文件（如 `.myagent/mem.json`）。Journal 桌面服务的后台常驻进程利用 **chokidar** 零感捕捉该文件变更，自动读入。

由于更新属于**低频串行**（一小时甚至一天几次），彻底规避了高并发下的读写锁文件（File Lock）竞态冲突。

### 2.3 内核层：本地事实蒸馏与去重（Fact Distillation & Deduplication）

捕获到的数据通过本地集成的事实提取引擎进行提炼。即使文件内容发生覆盖或微调，去重系统也会：

- 自动剔除冗余噪声；
- 识别新老事实冲突并进行智能覆盖；
- 将杂乱的文本沉淀为一条条纯净的、不可分割的 **“绳结（Facts）”资产**。

### 2.4 输出端：静态 MCP 被动供给（Static MCP Supply）

Journal 将中央项目记忆池封装为标准的 **MCP 接口工具**。由于 Claude Code 类工具并不支持在运行中接收外界的异步工具更新通知，本方案采用 **“启动前静态对齐”** 的逻辑：

> 当 Claude Code 开启新任务被唤醒时，会通过该 MCP Tool 主动向 Journal 发起一次检索请求，拉取前任 Agent 留下的最新绝对静态数据，完美规避伪实时脱节。

---

## 三、桌面端（Tauri + Node.js）核心模块工程实现

Journal 作为桌面 App，非研发人员**双击安装即自带所有环境**，消灭 Python/Node 依赖地狱。

### 3.1 后台核心总线：常驻文件监听与增量提取（background.js）

> ⚠️ 以下为示例代码，实施时需谨慎评审。

```javascript
import chokidar from 'chokidar';
import fs from 'fs-extra';
import { Memory } from 'mem0ai'; // 封装的本地内嵌级存储核心
import path from 'path';

const memoryBus = new Memory(); // 数据存储在本地嵌入式 SQLite 中

export function startJournalWatcher(projectPath) {
    const targetFile = path.join(projectPath, '.myagent/mem.json');
    const projectId = path.basename(projectPath); // 用项目名作为跨 Agent 的统一 user_id

    // 启动低频文件监听
    chokidar.watch(targetFile, { ignoreInitial: true }).on('change', (filePath) => {
        // 极简防抖，避开编辑器的瞬间连续写入锁
        setTimeout(async () => {
            try {
                const rawContent = await fs.readFile(filePath, 'utf-8');
                if (!rawContent.trim()) return;

                console.log(`[Journal Watcher] 捕获到自研记忆文件变更，执行增量洗入...`);
                // 自动进行实体提炼、语义冲突裁决与去重合并
                await memoryBus.add(rawContent, { user_id: projectId });
            } catch (err) {
                console.error("[Journal Error] 记忆流提取失败:", err);
            }
        }, 500);
    });
}
```

要点：

- 以**项目目录名**作为跨 Agent 的统一 `user_id`，实现项目级沙箱隔离；
- 500ms 防抖，避开编辑器的瞬间连续写入；
- `ignoreInitial: true`，只在变更时增量洗入。

### 3.2 傻瓜式一键配置：自动改写 Agent 的 MCP 依赖

当非研发人员在 UI 界面点击「激活 Claude Code 记忆」时，Tauri 后端自动用代码改写系统配置文件，彻底摆脱终端黑窗口。

> ⚠️ 以下为示例代码，实施时需谨慎评审。

```javascript
import os from 'os';
import path from 'path';
import fs from 'fs-extra';

export async function injectMcpToClaudeCode(tauriExecutablePath) {
    const mcpConfigPath = path.join(os.homedir(), '.claude', 'mcp.json');
    await fs.ensureDir(path.dirname(mcpConfigPath));

    let config = { mcpServers: {} };
    if (await fs.pathExists(mcpConfigPath)) {
        config = await fs.readJson(mcpConfigPath);
    }

    // 隐式强行挂载 Journal 的 MCP 运行时
    config.mcpServers["journal"] = {
        command: tauriExecutablePath,
        args: ["--mode", "mcp-server"]
    };

    await fs.writeJson(mcpConfigPath, config, { spaces: 2 });
    return "Journal 记忆总线已成功绑定至 Claude Code！";
}
```

### 3.3 MCP 服务端 Tool 供给（被动响应输出接口）

Journal 后端同时监听本地 Stdio 流，为启动的外部 Agent 随时按需输出记忆。

> ⚠️ 以下为示例代码，实施时需谨慎评审。

```javascript
// 当 Claude Code 启动并调用 "recall_memories" 工具时触发
async function handleMcpCall(query, projectId) {
    // 从本地已经通过监听洗净的中央库中，秒级语义检索高价值事实
    const matchedJournals = await memoryBus.search(query, { user_id: projectId });

    if (!matchedJournals || matchedJournals.length === 0) {
        return "【Journal 中央共享脑提示】当前项目暂无共享记忆沉淀。";
    }

    const formattedText = matchedJournals.map(k => `- ${k.content}`).join('\n');
    return `【Journal 中央共享脑提示】关联到的历史接力资产如下：\n${formattedText}`;
}
```

---

## 四、可视化白盒看板（Visual Control Panel）

为了打破 AI 记忆的“黑盒幻觉”，Journal 在前端提供一个极其简明、直观的可视化看板。

### 4.1 项目流管理

用户可直接通过 UI 界面将不同的本地项目目录**拖入 App**，系统自动以项目名（`project_id`）做沙箱隔离。

### 4.2 白盒化 Fact 卡片

被自动监听提炼出来的每一个“结（Fact）”都变成可视化卡片，例如：

> **[自研 Agent 沉淀]** 本项目目前强制使用 pnpm 且禁止使用 dynamic import。 ❌ *[非研发人员可手动点击删除]*
>
> **[自研 Agent 沉淀]** 昨天的打包报错已通过修改 vite.config.js 的代理解决。 ❌ *[非研发人员可手动点击修改]*

### 4.3 人工校准干预

非研发人员在把任务交给下一个 Agent 之前，可以在 UI 上**人工修正、增删卡片内容**，确保传递下去的情报绝对精准，防范 Agent 之间因错误记忆引发的脑裂冲突。

---

## 五、方案边界与设计取舍

- **优雅的黑盒解耦**：自研 Agent 和三方开源工具完全不需要为彼此做任何源码适配，Journal 依靠文件监听和 MCP 桥接充当隐形胶水。
- **完美契合工程边界**：放弃了对“执行中高频动态更新”的过度追求，专为**低频、串行、交替**的真实开发流水线而生，换来了极高的运行鲁棒性与超低的环境配置门槛。

---

## 六、技术选型清单 *（整理补充）*

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 桌面框架 | Electron | 中央主服务核心；Node 运行时承载 mem0 与文件监听 |
| 文件监听 | chokidar | 后台常驻异步监听 `.myagent/mem.json` 变更 |
| 文件操作 | fs-extra | 读写记忆文件、改写 MCP 配置文件 |
| 记忆引擎 | mem0ai（Mem0 官方 Node SDK，OSS 版） | 事实提炼、语义冲突裁决、去重合并；LLM 用 MiniMax（用户自配 API Key，可关闭） |
| 本地存储 | better-sqlite3（镜像库）+ mem0 自带 SQLite 向量库 | 记忆与向量 100% 本地留存；embedding 用 MiniMax embo-01（本地转换层适配） |
| Agent 协议 | MCP（Model Context Protocol） | Stdio 本地进程间通信，被动供给记忆 |
| 前端框架 | 待定（React / Vue / Svelte） | 用于第一版可视化记忆卡片流界面 |

---

## 七、实施规划 Roadmap *（整理补充）*

### 阶段一：项目骨架与监听验证

- 创建 Tauri 项目骨架（含 Node.js sidecar / background 进程）；
- 初始化 chokidar 监听测试环境，验证对 `.myagent/mem.json` 变更的零感捕获与防抖。

### 阶段二：核心提炼层

- 集成 mem0ai 本地内嵌存储（SQLite）；
- 实现事实提取、语义冲突裁决与去重合并流水线；
- 以项目名为 `user_id` 完成项目级隔离。

### 阶段三：MCP 服务端与配置注入

- 实现 Stdio 模式的 MCP Server（`--mode mcp-server`），暴露 `recall_memories` 工具；
- 实现 UI 一键改写 `~/.claude/mcp.json` 的注入逻辑（含已有配置的合并保护）。

### 阶段四：前端可视化看板

- 使用选定前端框架实现第一版可视化记忆卡片流界面（UI Prototype）；
- 支持项目目录拖入、Fact 卡片增删改、人工校准流程。

---

## 八、开放问题 *（整理补充，待定项）*

1. **记忆文件 Schema**：`.myagent/mem.json` 的具体数据格式约定（纯文本条目数组？带类型/时间戳的结构化对象？）需与自研 Agent 对齐。
2. **MCP Tool 接口签名**：`recall_memories` 的入参（query、project_id 的来源方式）、返回结构与 token 上限需进一步定义；是否需要额外的写入/列出工具待评估。
3. **提炼层本地化**：已决策：应用框架迁移至 Electron，真正引入 mem0ai 库做记忆管理；LLM 走 MiniMax（用户自配 API Key，默认关闭、设置中开启）；embedding 用 MiniMax embo-01，经本地 HTTP 转换层适配 OpenAI 格式（embo-01 实测不兼容 OpenAI input 格式）；向量库用 mem0 自带 SQLite 持久化（vectorStore.config.dbPath），无需 Qdrant。
4. **多项目隔离细节**：同目录改名、多 Agent 并发写同一文件（虽为低频但非零概率）的兜底策略。
5. **配置注入安全**：改写 `~/.claude/mcp.json` 前的备份与卸载/解绑（uninject）逻辑。
