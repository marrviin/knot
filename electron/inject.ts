//! One-click setup: registers Knot as an MCP server in Claude Code's user-level config.
//! (Ported from the Rust inject.rs; targets the top-level mcpServers key of
//! ~/.claude.json, with an automatic backup before writing.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

const SERVER_KEY = 'knot-shared-memory';

function configPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** In MCP mode, Claude Code spawns this app's executable to run the headless stdio server.
 *  Wrapped via /bin/sh to unset ELECTRON_RUN_AS_NODE — environments like the VS Code
 *  terminal inherit that variable, which would make the Electron binary start in pure
 *  Node mode (no app API available).
 *  Packaged: <Knot executable> --mcp-server; dev: electron <app dir> --mcp-server */
function serverEntry(): Record<string, unknown> {
  const knotBin = process.execPath;
  const rest = app.isPackaged ? ['--mcp-server'] : [app.getAppPath(), '--mcp-server'];
  return {
    command: '/bin/sh',
    args: ['-c', 'unset ELECTRON_RUN_AS_NODE; exec "$KNOT_BIN" "$@"', 'sh', ...rest],
    env: { KNOT_BIN: knotBin },
  };
}

function readConfig(p: string): Record<string, any> {
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new Error(`解析 ${p} 失败（文件不是合法 JSON）: ${e}`);
  }
}

function writeConfig(p: string, value: Record<string, any>): void {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

export function inject(): string {
  const p = configPath();
  if (fs.existsSync(p)) {
    fs.copyFileSync(p, p + '.knot-backup');
  }
  const config = readConfig(p);
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  config.mcpServers[SERVER_KEY] = serverEntry();
  writeConfig(p, config);
  return `Knot 记忆总线已绑定至 Claude Code（${p} → mcpServers.${SERVER_KEY}），重启 Claude Code 后生效。`;
}

export function remove(): string {
  const p = configPath();
  const config = readConfig(p);
  if (config.mcpServers && typeof config.mcpServers === 'object' && SERVER_KEY in config.mcpServers) {
    delete config.mcpServers[SERVER_KEY];
    writeConfig(p, config);
    return '已解绑 Knot 记忆总线，重启 Claude Code 后生效。';
  }
  return 'Knot 未绑定过 Claude Code，无需解绑。';
}

export function isInjected(): boolean {
  try {
    const config = readConfig(configPath());
    return !!config.mcpServers?.[SERVER_KEY];
  } catch {
    return false;
  }
}
