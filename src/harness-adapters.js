import { resolve } from 'node:path';
import { acknowledgeEvents, watchEvents } from './event-watcher.js';
import { validateAgentId } from './agent-coordination.js';

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const HARNESS_ADAPTERS = {
  'claude-code': { mechanism: 'Monitor', delivery: 'stdout NDJSON; explicit receipt acknowledgement', automaticStartup: 'interactive opt-in plugin only' },
  callback: { mechanism: 'caller-supplied supported callback', delivery: 'acknowledge only after callback accepts durably' },
  polling: { mechanism: 'pollEvents', delivery: 'one batch; explicit acknowledgement' },
  'blocking-wait': { mechanism: 'watchEvents with once and timeoutMs', delivery: 'bounded wait; explicit acknowledgement' }
};

// A native tool call descriptor, not a claim that Switchyard can invoke a tool
// in somebody else's process. Claude/its skill makes this call in that session.
export function claudeMonitorCall({ root, agentId, consumer, cliPath, nodePath = process.execPath, standalone = false, mode = 'interactive', timeoutMs = 300000 }) {
  if (!['interactive', 'print'].includes(mode)) throw new Error('Claude mode must be interactive or print.');
  const maximum = mode === 'print' ? 600000 : 1800000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximum) throw new Error(`Claude ${mode} Monitor timeout must be 1-${maximum} milliseconds.`);
  if (!cliPath || !root || !agentId || !consumer) throw new Error('Monitor requires cliPath, root, agentId and consumer.');
  agentId = validateAgentId(agentId); consumer = validateAgentId(consumer);
  const entry = standalone ? [resolve(cliPath)] : [nodePath, resolve(cliPath)];
  const command = [...entry, 'events', 'watch', '--coord-dir', resolve(root), '--agent-id', agentId, '--consumer', consumer].map(shellQuote).join(' ');
  return { harness: 'claude-code', tool: 'Monitor', input: { description: `Switchyard events for ${agentId}`, command, timeout_ms: timeoutMs },
    renewal: 'On the native expiration/close notice, start this Monitor call again with the same consumer. Read current tool availability and permissions first.',
    acknowledgement: 'After receipt is durably handled, run switchyard events ack EVENT_ID with the same board, agent-id and consumer. Stdout alone does not acknowledge.',
    fallback: 'Use events poll or a bounded blocking wait when Monitor/background tasks are unavailable; plugin monitors do not start in -p mode.' };
}

// Implement another harness by supplying its supported delivery callback. Do
// not invent stdin injection, a universal wake API, or Claude tools elsewhere.
export async function runCallbackAdapter(options, deliver) {
  if (typeof deliver !== 'function') throw new Error('Supply the harness-supported delivery callback.');
  return watchEvents({ ...options, onEvent: async event => {
    const receipt = await deliver(event);
    if (receipt?.accepted !== true) throw new Error('Harness callback did not confirm durable acceptance.');
    await acknowledgeEvents({ ...options, eventIds: [event.eventId] });
  } });
}
