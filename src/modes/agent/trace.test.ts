import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderTraceLine, writeTranscriptFile } from './trace';
import type { PiEvent } from './pi-types';

const ev = (type: string, extra: Record<string, unknown> = {}): PiEvent =>
  ({ type, ...extra }) as PiEvent;

describe('renderTraceLine', () => {
  it('renders tool calls with their arguments', () => {
    const line = renderTraceLine(
      ev('tool_execution_start', {
        toolCallId: 'c1',
        toolName: 'get_diff',
        args: { path: 'src/index.ts', offset: 201 },
      }),
    );
    expect(line).toBe('[pi] tool_call   get_diff {"path":"src/index.ts","offset":201}');
  });

  it('renders tool results with status and size', () => {
    const line = renderTraceLine(
      ev('tool_execution_end', {
        toolCallId: 'c1',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: 'x'.repeat(2048) }] },
      }),
    );
    expect(line).toMatch(/^\[pi\] tool_result read ok \(\d+(\.\d+)? KB\)$/);
    expect(line).not.toContain('xxxx'); // no result preview in compact
  });

  it('marks errored tool results', () => {
    const line = renderTraceLine(
      ev('tool_execution_end', {
        toolCallId: 'c1',
        toolName: 'submit_finding',
        isError: true,
        result: { content: [{ type: 'text', text: 'Line 1 is not an added line' }] },
      }),
    );
    expect(line).toContain('tool_result submit_finding ERROR');
    expect(line).toContain('Line 1 is not an added line');
  });

  it('includes a result preview only at full level', () => {
    const event = ev('tool_execution_end', {
      toolCallId: 'c1',
      toolName: 'get_diff',
      isError: false,
      result: { content: [{ type: 'text', text: 'patch lines 1-3 of 3' }] },
    });
    expect(renderTraceLine(event, 'compact')).not.toContain('patch lines');
    expect(renderTraceLine(event, 'full')).toContain('patch lines 1-3 of 3');
  });

  it('truncates long arguments at the level cap', () => {
    const long = 'x'.repeat(500);
    const event = ev('tool_execution_start', {
      toolCallId: 'c1',
      toolName: 'submit_finding',
      args: { evidence: long },
    });
    const compact = renderTraceLine(event, 'compact')!;
    const full = renderTraceLine(event, 'full')!;
    expect(compact.length).toBeLessThan(full.length);
    expect(compact.endsWith('…')).toBe(true);
  });

  it('renders assistant messages and error messages', () => {
    const msg = ev('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will inspect the runner next.' }],
      },
    });
    expect(renderTraceLine(msg)).toBe('[pi] assistant   I will inspect the runner next.');
    const err = ev('message_end', {
      message: { role: 'assistant', content: [], errorMessage: '401 invalid key' },
    });
    expect(renderTraceLine(err)).toBe('[pi] error       401 invalid key');
  });

  it('shows the transition from investigation to wrap-up', () => {
    expect(
      renderTraceLine(
        ev('message_end', {
          message: { role: 'custom', customType: 'reviewally_budget', content: 'Wrap up.' },
        }),
      ),
    ).toContain('investigation budget exhausted; wrapping up');
  });

  it('renders per-turn token usage', () => {
    const line = renderTraceLine(
      ev('turn_end', { message: { role: 'assistant', usage: { input: 9400, output: 310 } } }),
    );
    expect(line).toBe('[pi] turn end    tokens in=9400 out=310');
  });

  it('renders retries and compaction', () => {
    expect(
      renderTraceLine(ev('auto_retry_start', { attempt: 1, errorMessage: '529 overloaded' })),
    ).toBe('[pi] retry       attempt 1: 529 overloaded');
    expect(renderTraceLine(ev('compaction_start', { reason: 'threshold' }))).toBe(
      '[pi] compaction  reason=threshold',
    );
  });

  it('returns null for noise events and everything at off level', () => {
    expect(renderTraceLine(ev('turn_start'))).toBeNull();
    expect(renderTraceLine(ev('message_start', { message: { role: 'assistant' } }))).toBeNull();
    expect(renderTraceLine(ev('message_update', { usage: {} }))).toBeNull();
    expect(
      renderTraceLine(ev('message_end', { message: { role: 'user', content: 'hi' } })),
    ).toBeNull();
    const toolCall = ev('tool_execution_start', { toolName: 'read', args: {} });
    expect(renderTraceLine(toolCall, 'off')).toBeNull();
  });
});

describe('writeTranscriptFile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes raw JSONL and returns the path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-trace-'));
    vi.stubEnv('RUNNER_TEMP', dir);
    const events = [
      ev('turn_start'),
      ev('tool_execution_start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a' } }),
    ];
    const file = writeTranscriptFile(events);
    expect(file).toBe(path.join(dir, 'pi-transcript.jsonl'));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(events[0]);
    expect(JSON.parse(lines[1]!)).toEqual(events[1]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
