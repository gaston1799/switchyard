// Claude plugin lifecycle owns this adapter; the child is the reusable watcher.
// No heartbeat writes, receipt acknowledgements, shell eval, or model calls here.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const required = ['SWITCHYARD_CLI_JS', 'SWITCHYARD_COORD_DIR', 'SWITCHYARD_AGENT_ID', 'SWITCHYARD_EVENT_CONSUMER'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  process.stderr.write(`Switchyard plugin monitor is not configured: set ${missing.join(', ')} before starting Claude Code.\n`);
  process.exitCode = 2;
} else if (!isAbsolute(process.env.SWITCHYARD_CLI_JS) || !existsSync(process.env.SWITCHYARD_CLI_JS) || !isAbsolute(process.env.SWITCHYARD_COORD_DIR)) {
  process.stderr.write('Switchyard plugin monitor needs an existing absolute SWITCHYARD_CLI_JS and absolute SWITCHYARD_COORD_DIR.\n');
  process.exitCode = 2;
} else {
  let child, timer, stopped = false, retries = 0, lastNotice;
  const stop = () => {
    stopped = true; clearTimeout(timer);
    if (child && child.exitCode === null) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const start = () => {
    if (stopped) return;
    const startedAt = Date.now();
    child = spawn(process.execPath, [process.env.SWITCHYARD_CLI_JS, 'events', 'watch',
      '--coord-dir', process.env.SWITCHYARD_COORD_DIR, '--agent-id', process.env.SWITCHYARD_AGENT_ID,
      '--consumer', process.env.SWITCHYARD_EVENT_CONSUMER], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    let finished = false;
    const ended = reason => {
      if (finished) return; finished = true;
      if (stopped) return;
      if (Date.now() - startedAt > 60000) retries = 0;
      const backoff = Math.min(250 * 2 ** Math.min(retries++, 7), 30000);
      if (lastNotice !== reason) { process.stderr.write(`Switchyard watcher stopped (${reason}); reconnecting with the same consumer.\n`); lastNotice = reason; }
      timer = setTimeout(start, backoff);
    };
    child.once('error', error => ended(error.message));
    child.once('exit', (code, signal) => ended(signal || `exit ${code}`));
  };
  start();
}
