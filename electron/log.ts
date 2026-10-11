//! Lightweight file logger: appends timestamped lines to userData/knot.log.
//! The dev terminal's console output isn't accessible post-hoc, so key main-process
//! events (project add, import, mem0 sync) are mirrored to a file for diagnosis.

import path from 'node:path';
import fs from 'node:fs';

let logFile = '';

export function initLog(userDataDir: string): void {
  logFile = path.join(userDataDir, 'knot.log');
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logFile) {
    fs.appendFile(logFile, line + '\n', () => {});
  }
}
