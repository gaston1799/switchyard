import { fileURLToPath } from 'node:url';
import { coordinationRoot } from './agent-coordination.js';
import { acknowledgeEvents, watchEvents } from './event-watcher.js';
import { claudeMonitorCall, HARNESS_ADAPTERS } from './harness-adapters.js';

const HELP = `Usage: switchyard events watch|poll|ack <event-id>...|adapter claude-code|adapters
  --coord-dir DIR --agent-id ID --consumer STABLE-ID
  watch: [--poll-ms 1000] [--timeout-ms 0]
  poll:  [--wait-ms 0] [--poll-ms 1000]
  adapter claude-code: [--mode interactive|print] [--timeout-ms 300000]
Events are NDJSON. Only ack records receipt; watch/poll never consume inbox messages.
Keep the existing heartbeat separate. Renew expired Monitor calls with the same consumer.\n`;

export async function runEventsCli(argv, { output = process.stdout, errorOutput = process.stderr, signal } = {}) {
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) { output.write(HELP); return; }
  const args = {}, positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!['--coord-dir', '--agent-id', '--consumer', '--poll-ms', '--timeout-ms', '--wait-ms', '--mode'].includes(arg)) throw new Error(`Unknown events option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[arg.slice(2)] = value;
  }
  const [command, ...rest] = positional;
  if (command === 'adapters' && !rest.length) { output.write(`${JSON.stringify(HARNESS_ADAPTERS, null, 2)}\n`); return; }
  const root = coordinationRoot(args['coord-dir']);
  const agentId = args['agent-id'], consumer = args.consumer;
  if (!agentId || !consumer) throw new Error('--agent-id and --consumer are required.');
  if (command === 'adapter' && rest.length === 1 && rest[0] === 'claude-code') {
    const standalone = typeof __SWITCHYARD_STANDALONE__ !== 'undefined' && __SWITCHYARD_STANDALONE__;
    const call = claudeMonitorCall({ root, agentId, consumer, standalone,
      cliPath: standalone ? process.execPath : fileURLToPath(new URL('./deepseek-watch.js', import.meta.url)), mode: args.mode,
      timeoutMs: args['timeout-ms'] === undefined ? 300000 : Number(args['timeout-ms']) });
    output.write(`${JSON.stringify(call, null, 2)}\n`); return;
  }
  if (command === 'ack') { output.write(`${JSON.stringify(await acknowledgeEvents({ root, agentId, consumer, eventIds: rest }))}\n`); return; }
  if (!['watch', 'poll'].includes(command) || rest.length) throw new Error(HELP);
  const timeoutMs = Number(command === 'poll' ? args['wait-ms'] || 0 : args['timeout-ms'] || 0);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const effectiveSignal = controller.signal;
  let outputError;
  const onOutputError = error => { outputError = error; abort(); };
  output.on?.('error', onOutputError);
  if (!signal) { process.once('SIGINT', abort); process.once('SIGTERM', abort); }
  try {
    await watchEvents({ root, agentId, consumer, pollMs: Number(args['poll-ms'] || 1000), timeoutMs, once: command === 'poll', signal: effectiveSignal,
      onDiagnostic: value => errorOutput.write(`Switchyard watcher: ${JSON.stringify(value)}\n`),
      onEvent: event => new Promise((done, reject) => {
        if (effectiveSignal.aborted) { reject(new Error('Watcher stopped')); return; }
        const onAbort = () => { effectiveSignal.removeEventListener('abort', onAbort); reject(new Error('Watcher stopped')); };
        effectiveSignal.addEventListener('abort', onAbort, { once: true });
        output.write(`${JSON.stringify(event)}\n`, error => { effectiveSignal.removeEventListener('abort', onAbort); error ? reject(error) : done(); });
      }) });
  } finally {
    signal?.removeEventListener('abort', abort);
    output.off?.('error', onOutputError);
    if (!signal) { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  if (outputError && outputError.code !== 'EPIPE') throw outputError;
}
