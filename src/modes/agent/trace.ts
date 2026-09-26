import * as core from '@actions/core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

const MAX_EVENT_CHARS = 64000;
const MAX_TRACE_CHARS = 2_000_000;

export function agentTraceEnabled(
  value: string | undefined = process.env.REVIEWALLY_AGENT_TRACE,
): boolean {
  if (value === undefined || value.trim() === '') return true;
  if (['true', '1', 'on'].includes(value.trim().toLowerCase())) return true;
  if (['false', '0', 'off'].includes(value.trim().toLowerCase())) return false;
  throw new Error('Invalid REVIEWALLY_AGENT_TRACE: expected true or false.');
}

export function createAgentTracer(
  enabled: boolean,
  secrets: string[],
  log: (message: string) => void = core.info,
): (event: AgentSessionEvent) => void {
  let written = 0;
  let capped = false;
  const mask = (text: string): string => {
    let safe = text;
    for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[REDACTED]');
    return safe
      .replace(/\bgh[pousr]_[a-zA-Z0-9_]+\b/g, '[REDACTED]')
      .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  };
  return (event) => {
    if (!enabled || capped) return;
    let record: unknown;
    if (event.type === 'message_end') {
      record = {
        event: 'message_end',
        role: event.message.role,
        message: event.message,
      };
    } else if (event.type === 'tool_execution_start') {
      record = { event: 'tool_call', id: event.toolCallId, name: event.toolName, args: event.args };
    } else if (event.type === 'tool_execution_end') {
      record = {
        event: 'tool_result',
        id: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        result: event.result,
      };
    } else if (event.type === 'agent_settled') {
      record = { event: 'agent_settled' };
    } else {
      return;
    }
    let serialized: string | undefined;
    const seen = new WeakSet<object>();
    try {
      serialized = JSON.stringify(record, (key: string, value: unknown) => {
        const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
        if (
          [
            'apikey',
            'authorization',
            'token',
            'accesstoken',
            'password',
            'secret',
            'clientsecret',
            'privatekey',
          ].includes(normalizedKey)
        ) {
          return '[REDACTED]';
        }
        if (value && typeof value === 'object') {
          if ('type' in value && value.type === 'image') return '[image omitted]';
          if ('type' in value && value.type === 'thinking') return '[provider reasoning omitted]';
          if (seen.has(value)) return '[repeated object]';
          seen.add(value);
        }
        if (typeof value === 'bigint') return value.toString();
        return value;
      });
    } catch {
      log('[ReviewAlly agent trace] Event could not be serialized; omitted.');
      return;
    }
    if (!serialized) return;
    const safe = mask(serialized);
    const truncated =
      safe.length > MAX_EVENT_CHARS
        ? `${safe.slice(0, MAX_EVENT_CHARS)} [event truncated: ${safe.length - MAX_EVENT_CHARS} characters]`
        : safe;
    if (written + truncated.length > MAX_TRACE_CHARS) {
      log('[ReviewAlly agent trace capped at 2,000,000 characters; remaining events omitted.]');
      capped = true;
      return;
    }
    written += truncated.length;
    log(`[ReviewAlly agent trace] ${truncated}`);
  };
}
