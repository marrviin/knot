#!/usr/bin/env node
// Kill processes occupying the given ports; used by pnpm dev to clean up leftover vite/server processes
import { execSync } from 'node:child_process';

const ports = process.argv.slice(2);
if (ports.length === 0) {
  console.error('Usage: node scripts/kill-port.mjs <port> [port...]');
  process.exit(1);
}

for (const port of ports) {
  let pids = '';
  try {
    pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
  } catch {
    // lsof exits non-zero with no match — treat the port as free
  }
  if (!pids) continue;

  const pidList = pids.split('\n').filter(Boolean);
  console.log(`[kill-port] 端口 ${port} 被占用 (pid: ${pidList.join(', ')}),正在终止...`);
  try {
    execSync(`kill ${pidList.join(' ')}`);
    // Wait for the process to exit, force-kill if it won't
    for (let i = 0; i < 10; i++) {
      let alive = '';
      try {
        alive = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
      } catch {
        break;
      }
      if (!alive) break;
      execSync('sleep 0.2');
    }
    let rest = '';
    try {
      rest = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
    } catch {}
    if (rest) {
      console.log(`[kill-port] SIGTERM 未生效,强制 kill -9...`);
      execSync(`kill -9 ${rest.split('\n').join(' ')}`);
    }
  } catch (err) {
    console.error(`[kill-port] 终止端口 ${port} 的进程失败:`, err.message);
    process.exit(1);
  }
  console.log(`[kill-port] 端口 ${port} 已释放`);
}
