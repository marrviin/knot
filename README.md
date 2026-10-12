# 🐋 Knot

**English** | [简体中文](README.zh-CN.md)

An event-driven **local shared-memory bus for multi-agent serial workflows** (Electron desktop app; memory management powered by [mem0](https://github.com/mem0ai/mem0)).

Design and roadmap: [docs/design.md](docs/design.md).

## How It Works

```
Custom agent --low-frequency overwrite--> .myagent/mem.json
                                              │ background chokidar watch (500ms debounce)
                                              ▼
   Knot desktop: mem0 refinement pipeline (fact extraction → semantic dedup → conflict resolution)
                + SQLite mirror store + white-box fact board
                                              │ local HTTP MCP server (http://127.0.0.1:27183/mcp)
                                              ▼
        Claude Code --MCP tool recall_memories--> pull shared memory
```

- **Ingest**: chokidar watches `.myagent/mem.json` in every registered project; raw text is handed to mem0 for refinement (fact extraction, semantic dedup, new-vs-old conflict resolution). LLM + embeddings via MiniMax or any OpenAI-compatible service (user-supplied API key; MiniMax embeddings go through a local format-translation shim).
- **Storage**: mem0's built-in SQLite vector store (`<userData>/mem0/vectors.db`) is the source of truth; a `knot.db` mirror serves the UI board and MCP keyword search, linked by memory uuid.
- **Output**: the running app hosts a local HTTP MCP server (`http://127.0.0.1:27183/mcp`, port overridable via `KNOT_MCP_PORT`) exposing `recall_memories` / `list_projects`; a headless stdio mode (`--mcp-server`) remains as a fallback. Retrieval is hybrid: FTS5 BM25 keyword search fused with mem0 semantic vector search via RRF (source-labeled results; degrades to pure BM25 when no LLM service is configured).
- **Board**: white-box fact cards with manual add/edit/delete (changes sync back to mem0), preventing memory divergence between agents.

## Development

```bash
pnpm install
pnpm dev               # dev mode (rebuilds better-sqlite3 for Electron ABI automatically)
pnpm build             # production build
pnpm rebuild:electron  # rebuild better-sqlite3 for Electron ABI only
```

Requires Node ≥ 20 (pnpm). Packaging via electron-builder is not configured yet (planned).

Note: if your terminal has `ELECTRON_RUN_AS_NODE=1` set (common in the VS Code integrated terminal),
start with `env -u ELECTRON_RUN_AS_NODE`.

## Usage

1. Drag a project folder into the window (or click "Add Project") — Knot starts watching `.myagent/mem.json` inside it;
2. Fill in your MiniMax API key under refinement settings and enable LLM refinement;
3. Click "Activate Claude Code memory" — Knot registers an HTTP entry (`http://127.0.0.1:27183/mcp`) into the `mcpServers` key of `~/.claude.json` (auto-backup before writing);
4. Restart Claude Code; at the start of a new task, call `recall_memories` to pull the memory left behind by previous agents.

## Custom Agent Write Format

`.myagent/mem.json` accepts any reasonable JSON structure or plain text — the LLM extracts hard facts on its own:

```json
["This project enforces pnpm", "No dynamic imports"]
```

```json
{ "facts": [{ "content": "Build error was fixed by changing the vite.config.js proxy" }] }
```
