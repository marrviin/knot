# Knot 记忆服务（knot-server）

Knot 的记忆核心（mem0 抽取/去重/冲突裁决 + 向量库）抽成的独立 HTTP 服务。
Electron 客户端默认以子进程方式在本地拉起它；用户也可以用本目录自行部署，
在 Knot 设置里把记忆存储切到「远程服务」模式实现跨设备同步。

## API（JSON）

| 方法/路径 | 作用 |
|---|---|
| `GET /health` | 存活 + 就绪状态 + embedding 签名（无需鉴权） |
| `POST /ingest` `{projectId, raw, meta{agent,type,source}, preferExisting?}` | LLM 提炼入库，返回 `{report, facts}` |
| `POST /facts` `{projectId, content}` | 手动录入（走提炼管线），返回同上 |
| `PUT /facts/:id` `{content}` | 更新一条记忆 |
| `DELETE /facts/:id` | 删除一条记忆 |
| `GET /projects/:projectId/facts` | 项目全量事实（镜像恢复用） |
| `POST /search` `{projectId, query, topK?}` | 语义检索 |
| `GET /projects/:projectId/count?agent=` | 按 agent 计数（存量导入检查用） |

除 `/health` 外都需要鉴权（配置了 `KNOT_TOKEN` 时）：`Authorization: Bearer <token>`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KNOT_PORT` | `27184` | 监听端口 |
| `KNOT_HOST` | `127.0.0.1` | 监听地址（Docker 里由镜像设为 `0.0.0.0`） |
| `KNOT_DATA_DIR` | `./data` | 数据目录（vectors.db / history.db / embed-signature） |
| `KNOT_TOKEN` | 空 | 访问令牌；远程部署务必设置 |
| `KNOT_LLM_BASE_URL` | `https://api.openai.com/v1` | API Base URL（任意 OpenAI 兼容服务） |
| `KNOT_LLM_API_KEY` | 空 | **必填**，未配置时服务可启动但不可提炼 |
| `KNOT_LLM_MODEL` | `gpt-5-mini` | 提炼模型 |

## 本地开发

```bash
# 依赖已在仓库根 node_modules（mem0ai / better-sqlite3 已按 Electron ABI rebuild）
pnpm build:server
KNOT_DATA_DIR=/tmp/knot-data KNOT_LLM_API_KEY=xxx node dist-server/index.js
```

本地模式下 Electron 会以 `ELECTRON_RUN_AS_NODE=1` 拉起同一份 bundle，
并通过 env 注入用户设置，无需手动运行。

## Docker 部署

```bash
# 仓库根目录：
pnpm build:server
docker build -t knot-server -f server/Dockerfile .
docker run -d --name knot-memory -p 27184:27184 \
  -e KNOT_TOKEN=$(openssl rand -hex 16) \
  -e KNOT_LLM_API_KEY=<你的key> \
  -v knot-data:/data \
  knot-server
```

然后在 Knot 设置里选择「远程服务」，填入 `http://<host>:27184` 与 `KNOT_TOKEN`，
点「测试连接」验证（/health 会返回服务端 embedding 签名，用于核对向量空间）。

## 注意事项

- **服务不可达直接报错**：客户端不会降级写本地镜像，保证镜像永远不与服务端分叉。
- **不做自动迁移**：本地已有记忆不会自动上传远程；远程部署后从零开始积累。
- **换 embedding 模型 = 换向量空间**：服务端会校验 `embed-signature` 并在日志中告警，
  语义检索失效，需清空 `KNOT_DATA_DIR` 重新导入。
