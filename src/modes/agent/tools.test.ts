import { describe, it, expect } from 'vitest';
import type { FetchResult, ChangedFile } from '../../shared/types';
import type { PiEvent } from './pi-types';
import { buildDiffsPayload, collectAgentToolCalls, MAX_FINDINGS } from './tools';

function makeFiles(): ChangedFile[] {
  return [
    {
      filename: 'src/a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      lines: [
        { type: 'context', oldLine: 1, newLine: 1, content: 'ctx' },
        { type: 'delete', oldLine: 2, content: 'old' },
        { type: 'add', newLine: 2, content: 'new' },
      ],
    },
    {
      filename: 'src/b.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
      lines: [{ type: 'add', newLine: 1, content: 'whole file' }],
    },
  ];
}

function makeFetch(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    files: makeFiles(),
    totalFiles: 2,
    reviewedFiles: 2,
    truncated: false,
    ...overrides,
  };
}

const FINDING_ARGS = {
  path: 'src/a.ts',
  line: 2,
  title: 'Off-by-one',
  severity: 'high',
  impact: 'Breaks lookup',
  evidencePath: 'src/a.ts',
  evidenceLine: 2,
  evidence: 'Index never bounded',
  suggestedFix: 'Clamp the index',
};

describe('buildDiffsPayload', () => {
  it('maps changed files into the get_diff payload with old/new line numbers', () => {
    const payload = buildDiffsPayload(makeFetch());
    expect(payload.truncated).toBe(false);
    expect(payload.totalFiles).toBe(2);
    expect(payload.reviewedFiles).toBe(2);
    expect(payload.files).toHaveLength(2);
    const a = payload.files[0]!;
    expect(a.path).toBe('src/a.ts');
    expect(a.status).toBe('modified');
    expect(a.additions).toBe(2);
    expect(a.deletions).toBe(1);
    expect(a.lines[0]).toEqual({ type: 'context', oldLine: 1, newLine: 1, content: 'ctx' });
    expect(a.lines[1]).toEqual({ type: 'delete', oldLine: 2, content: 'old' });
    expect(a.lines[2]).toEqual({ type: 'add', newLine: 2, content: 'new' });
  });

  it('carries the truncation flag so get_diff can disclose incomplete selection', () => {
    const payload = buildDiffsPayload(
      makeFetch({
        truncated: true,
        truncatedReason: 'Reached max-files limit (20)',
        totalFiles: 30,
        reviewedFiles: 20,
      }),
    );
    expect(payload.truncated).toBe(true);
    expect(payload.totalFiles).toBe(30);
    expect(payload.reviewedFiles).toBe(20);
  });
});

function toolStart(id: string, toolName: string, args: unknown): PiEvent {
  return { type: 'tool_execution_start', toolCallId: id, toolName, args };
}

function toolEnd(id: string, toolName: string, isError = false, result?: unknown): PiEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: id,
    toolName,
    isError,
    result: result ?? { content: [{ type: 'text', text: 'ok' }] },
  };
}

describe('collectAgentToolCalls', () => {
  it('collects findings, finish, and get_diff coverage from completed calls', () => {
    const events = [
      toolStart('1', 'get_diff', { path: 'src/a.ts' }),
      toolEnd('1', 'get_diff'),
      toolStart('2', 'submit_finding', FINDING_ARGS),
      toolEnd('2', 'submit_finding'),
      toolStart('3', 'finish_review', {
        summary: 'Solid change',
        limitations: ['did not run tests'],
        fileSummaries: [{ path: 'src/a.ts', description: 'tweak' }],
      }),
      toolEnd('3', 'finish_review'),
    ];
    const calls = collectAgentToolCalls(events);
    expect(calls.findings).toEqual([FINDING_ARGS]);
    expect(calls.finish?.summary).toBe('Solid change');
    expect(calls.finish?.limitations).toEqual(['did not run tests']);
    expect(calls.finish?.fileSummaries).toEqual([{ path: 'src/a.ts', description: 'tweak' }]);
    expect(calls.inspectedPaths).toEqual(['src/a.ts']);
    expect(calls.diffCalls).toBe(1);
    expect(calls.toolErrors).toEqual([]);
    expect(calls.uncompletedCalls).toBe(0);
  });

  it('ignores other tools and keeps unique inspected paths across pages', () => {
    const events = [
      toolStart('r1', 'read', { path: 'src/a.ts' }),
      toolEnd('r1', 'read'),
      toolStart('1', 'get_diff', { path: 'src/a.ts' }),
      toolEnd('1', 'get_diff'),
      toolStart('2', 'get_diff', { path: 'src/a.ts', offset: 201 }),
      toolEnd('2', 'get_diff'),
    ];
    const calls = collectAgentToolCalls(events);
    expect(calls.inspectedPaths).toEqual(['src/a.ts']);
    expect(calls.diffCalls).toBe(2);
    expect(calls.findings).toEqual([]);
    expect(calls.finish).toBeUndefined();
  });

  it('does not count errored tool calls as recorded results', () => {
    const events = [
      toolStart('1', 'submit_finding', { ...FINDING_ARGS, line: 1 }),
      toolEnd('1', 'submit_finding', true, {
        content: [{ type: 'text', text: 'not an added line' }],
      }),
    ];
    const calls = collectAgentToolCalls(events);
    expect(calls.findings).toEqual([]);
    expect(calls.toolErrors).toEqual(['submit_finding: not an added line']);
  });

  it('counts calls with a start but no end as uncompleted', () => {
    const events = [
      toolStart('1', 'get_diff', { path: 'src/a.ts' }),
      toolEnd('1', 'get_diff'),
      toolStart('2', 'submit_finding', FINDING_ARGS),
      // process died before the end event
    ];
    const calls = collectAgentToolCalls(events);
    expect(calls.findings).toEqual([]);
    expect(calls.uncompletedCalls).toBe(1);
  });

  it('uses the last finish_review when several completed', () => {
    const events = [
      toolStart('1', 'finish_review', { summary: 'first' }),
      toolEnd('1', 'finish_review'),
      toolStart('2', 'finish_review', { summary: 'second' }),
      toolEnd('2', 'finish_review'),
    ];
    const calls = collectAgentToolCalls(events);
    expect(calls.finish?.summary).toBe('second');
  });

  it('coerces malformed args defensively instead of throwing', () => {
    const events = [
      toolStart('1', 'submit_finding', { path: 42, line: 'x', severity: 'ultra' }),
      toolEnd('1', 'submit_finding'),
      toolStart('2', 'finish_review', {
        summary: 7,
        limitations: ['ok', 3],
        fileSummaries: [{ path: 'p' }],
      }),
      toolEnd('2', 'finish_review'),
    ];
    const calls = collectAgentToolCalls(events);
    expect(calls.findings[0]?.path).toBe('');
    expect(Number.isNaN(calls.findings[0]?.line)).toBe(true);
    expect(calls.findings[0]?.severity).toBe('low');
    expect(calls.finish?.summary).toBe('');
    expect(calls.finish?.limitations).toEqual(['ok']);
    expect(calls.finish?.fileSummaries).toEqual([]);
  });

  it('caps collected findings at MAX_FINDINGS', () => {
    const events: PiEvent[] = [];
    for (let i = 0; i < MAX_FINDINGS + 5; i++) {
      events.push(toolStart(`f${i}`, 'submit_finding', { ...FINDING_ARGS, line: 2 + i }));
      events.push(toolEnd(`f${i}`, 'submit_finding'));
    }
    const calls = collectAgentToolCalls(events);
    expect(calls.findings).toHaveLength(MAX_FINDINGS);
  });

  it('returns an empty outcome for an event stream with no tool calls', () => {
    const calls = collectAgentToolCalls([
      { type: 'turn_start' },
      { type: 'turn_end', message: { role: 'assistant' } },
      { type: 'agent_end', messages: [] },
    ]);
    expect(calls.findings).toEqual([]);
    expect(calls.finish).toBeUndefined();
    expect(calls.inspectedPaths).toEqual([]);
    expect(calls.diffCalls).toBe(0);
    expect(calls.uncompletedCalls).toBe(0);
  });
});
