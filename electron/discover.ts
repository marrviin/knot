//! Auto discovery: pulls all project directories Claude Code has opened from its
//! user config (~/.claude.json), so users don't have to add them manually.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function discoverClaudeProjects(): string[] {
  const configPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(configPath)) return [];

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error('[Knot Discover] 解析 ~/.claude.json 失败:', e);
    return [];
  }

  const projects = config.projects;
  if (!projects || typeof projects !== 'object') return [];

  const out: string[] = [];
  for (const key of Object.keys(projects)) {
    try {
      if (fs.statSync(key).isDirectory()) out.push(fs.realpathSync(key));
    } catch {
      // Directory missing or inaccessible — skip
    }
  }
  return out;
}
