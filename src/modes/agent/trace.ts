import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@actions/core';
import type { PiLogLevel } from '../../config/types';
import { messageText } from './pi-output';
import type { PiEvent } from './pi-types';

const PREFIX = '[pi]';

const CAPS: Record<Exclude<PiLogLevel, 'off'>, { args: number; text: number; result: number }> = {
  compact: { args: 300, text: 160, result: 0 },
  full: { args: 2000, text: 1000, result: 400 },
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toolResultSize(result: unknown): number {
  try {
    return JSON.stringify(result ?? '').length;
  } catch {
    return 0;
  }
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const first = content.find(
    (c): c is { type: string; text?: string } =>
      typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text',
  );
  return (first?.text ?? '').replace(/\r?\n/g, ' ').trim();
}

/**
 * Render one pi JSONL event as a single human-readable trace line, or null
 * when the event is not worth logging at the given level.
 */
export function renderTraceLine(event: PiEvent, level: PiLogLevel = 'compact'): string | null {
  if (level === 'off') return null;
  const caps = CAPS[level];

  switch (event.type) {
    case 'tool_execution_start': {
      if (typeof event.toolName !== 'string') return null;
      const args =
        event.args === undefined ? '' : truncate(JSON.stringify(event.args) ?? '', caps.args);
      return `${PREFIX} tool_call   ${event.toolName} ${args}`.trimEnd();
    }
    case 'tool_execution_end': {
      if (typeof event.toolName !== 'string') return null;
      const status = event.isError ? 'ERROR' : 'ok';
      const size = humanBytes(toolResultSize(event.result));
      const preview =
        caps.result > 0 ? ` ${truncate(toolResultText(event.result), caps.result)}` : '';
      return `${PREFIX} tool_result ${event.toolName} ${status} (${size})${preview}`;
    }
    case 'message_end': {
      const message = event.message;
      if (!message || message.role !== 'assistant') return null;
      if (message.errorMessage) {
        return `${PREFIX} error       ${truncate(message.errorMessage, caps.text)}`;
      }
      const text = messageText(message);
      if (!text) return null;
      return `${PREFIX} assistant   ${truncate(text.replace(/\r?\n/g, ' '), caps.text)}`;
    }
    case 'turn_end': {
      const usage = event.message?.usage;
      if (!usage) return null;
      return `${PREFIX} turn end    tokens in=${usage.input ?? 0} out=${usage.output ?? 0}`;
    }
    case 'auto_retry_start':
      return `${PREFIX} retry       attempt ${event.attempt ?? '?'}: ${truncate(event.errorMessage ?? '', caps.text)}`;
    case 'compaction_start':
      return `${PREFIX} compaction  reason=${event.reason ?? '?'}`;
    case 'agent_end':
      return `${PREFIX} agent_end`;
    default:
      return null;
  }
}

/** Live-trace hook for invokePi: prints one rendered line per parsed event. */
export function liveTracer(level: PiLogLevel): (event: PiEvent) => void {
  return (event) => {
    const line = renderTraceLine(event, level);
    if (line) core.info(line);
  };
}

/**
 * Dump the full raw event stream into a collapsed log group — the complete
 * record of what the agent did, for post-mortems on failure or timeout.
 */
export function logTranscript(events: PiEvent[]): void {
  core.startGroup(`pi transcript (${events.length} event(s))`);
  for (const event of events) {
    core.info(truncate(JSON.stringify(event) ?? '', 4000));
  }
  core.endGroup();
}

/** Write the raw JSONL transcript next to the runner temp dir; returns its path. */
export function writeTranscriptFile(events: PiEvent[]): string {
  const dir = process.env.RUNNER_TEMP || os.tmpdir();
  const file = path.join(dir, 'pi-transcript.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}
