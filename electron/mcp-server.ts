//! MCP server (stdio mode): line-delimited JSON-RPC 2.0.
//! When Claude Code spawns this process via `<knot> --mcp-server`,
//! it passively serves each project's shared memories (keyword search over the
//! facts mirror store) over stdin/stdout.

import * as readline from 'node:readline';
import { app } from 'electron';

import * as store from './store';

export function runMcpServer(): void {

  const rl = readline.createInterface({ input: process.stdin });
  const write = (obj: unknown) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore invalid lines
    }

    const id = msg.id ?? null;
    const method: string = msg.method ?? '';
    if (method.startsWith('notifications/')) return; // notifications need no reply

    let result: unknown;
    try {
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'knot-shared-memory', version: app.getVersion() },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = toolsManifest();
          break;
        case 'tools/call':
          result = handleToolCall(msg);
          break;
        default:
          write({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `方法未实现: ${method}` },
          });
          return;
      }
      write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: String(e) },
      });
    }
  });

  rl.on('close', () => process.exit(0));
}

function toolsManifest() {
  return {
    tools: [
      {
        name: 'fetch_project_knot',
        description:
          '检索当前项目由前任 Agent 沉淀的共享记忆(绳结 Facts)。建议在新任务开始时调用一次,拉取最新静态记忆;可传 query 关键词做定向检索。',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '关键词(可选)。不传则返回最近沉淀的记忆。多个关键词用空格分隔。',
            },
            project_id: {
              type: 'string',
              description: '项目名(可选)。默认取当前工作目录的目录名。',
            },
          },
        },
      },
      {
        name: 'list_knot_projects',
        description: '列出 Knot 中登记的所有项目及其记忆数量。',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function handleToolCall(msg: any) {
  const name: string = msg.params?.name ?? '';
  const args = msg.params?.arguments ?? {};

  let text: string;
  switch (name) {
    case 'fetch_project_knot':
      text = fetchKnots(args);
      break;
    case 'list_knot_projects':
      text = listProjectsText();
      break;
    default:
      return toolError(`未知工具: ${name}`);
  }
  return { content: [{ type: 'text', text }] };
}

function currentProjectId(): string {
  try {
    return process.cwd().split('/').pop() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function fetchKnots(args: any): string {
  const projectId: string = args.project_id ?? currentProjectId();
  const query: string | undefined = args.query;

  let facts: store.Fact[];
  try {
    facts = store.searchFacts(projectId, query);
  } catch (e) {
    return `【Knot 中央共享脑提示】检索失败: ${e}`;
  }

  if (facts.length === 0) {
    return `【Knot 中央共享脑提示】项目「${projectId}」${
      query ? '检索无命中，' : ''
    }暂无共享记忆沉淀。`;
  }

  const body = facts.map((f) => `- ${f.content}`).join('\n');
  return `【Knot 中央共享脑提示】项目「${projectId}」关联到的历史接力资产如下：\n${body}`;
}

function listProjectsText(): string {
  const projects = store.listProjects();
  if (projects.length === 0) {
    return '【Knot 中央共享脑提示】暂无已登记项目。';
  }
  const body = projects
    .map((p) => `- ${p.name}（${p.factCount} 条记忆）: ${p.path}`)
    .join('\n');
  return `【Knot 中央共享脑提示】已登记项目：\n${body}`;
}
