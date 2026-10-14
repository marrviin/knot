//! Server entry: load env config, bind routes, listen. SIGTERM/SIGINT close the
//! app and tear the mem0 instance (and its embedding shim) down cleanly.

import { buildApp } from './app';
import { loadConfig } from './config';
import { shutdown } from './core';
import { startJournalScheduler } from './core/journal-gen';
import { ensurePartnerPersonality } from './routes/settings';

const cfg = loadConfig();
const app = buildApp(cfg);

app
  .listen({ port: cfg.port, host: cfg.host })
  .then(() => {
    app.log.info(`Journal 记忆服务已启动: http://${cfg.host}:${cfg.port}（数据目录 ${cfg.dataDir}）`);
    // 搭档性格：首次启动随机抽取，之后固定（设置页可「换一个」重抽）
    ensurePartnerPersonality(cfg.dataDir);
    // Journal writer: backfill missing past-day logs at startup, then hourly
    startJournalScheduler(cfg.llm, cfg.dataDir);
  })
  .catch((e) => {
    app.log.error(`启动失败: ${e}`);
    // Port taken / data dir unusable: exit non-zero so the parent's health poll
    // fails fast instead of hanging until its spawn timeout.
    process.exit(1);
  });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info(`收到 ${sig}，正在关闭`);
    app
      .close()
      .catch(() => {})
      .finally(() => {
        shutdown();
        process.exit(0);
      });
  });
}
