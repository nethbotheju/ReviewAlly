import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChangedFile } from '../../shared/types';
import type { AgentFinding, AgentToolCalls } from './tools';
import { validateAgentFindings } from './validate';

let snapshot: string;

const FILES: ChangedFile[] = [
  {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    lines: [
      { type: 'context', oldLine: 1, newLine: 1, content: 'ctx' },
      { type: 'delete', oldLine: 2, content: 'old' },
      { type: 'add', newLine: 2, content: 'const x = unbounded();' },
      { type: 'add', newLine: 3, content: 'return x;' },
    ],
  },
  {
    filename: 'docs/gone.md',
    status: 'modified',
    additions: 1,
    deletions: 0,
    lines: [{ type: 'add', newLine: 1, content: 'text' }],
  },
  {
    filename: 'src/binary.bin',
    status: 'modified',
    additions: 10,
    deletions: 0,
    lines: [],
  },
];

function finding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    path: 'src/a.ts',
    line: 2,
    title: 'Unbounded call',
    severity: 'high',
    impact: 'Can throw on empty input',
    evidencePath: 'src/a.ts',
    evidenceLine: 2,
    evidence: 'unbounded() is called without a guard',
    suggestedFix: 'Guard the input first',
    ...overrides,
  };
}

function calls(findings: AgentFinding[]): AgentToolCalls {
  return {
    findings,
    finish: { summary: 's', limitations: [], fileSummaries: [] },
    inspectedPaths: [],
    diffCalls: 1,
    toolErrors: [],
    uncompletedCalls: 0,
  };
}

beforeEach(() => {
  snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-validate-'));
  fs.mkdirSync(path.join(snapshot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(snapshot, 'src', 'a.ts'),
    'line0\nconst x = unbounded();\nreturn x;\n',
  );
  fs.writeFileSync(path.join(snapshot, 'other.ts'), 'a\nb\nc\n');
});

afterEach(() => {
  fs.rmSync(snapshot, { recursive: true, force: true });
});

describe('validateAgentFindings', () => {
  it('accepts a well-formed finding anchored to an added line with snapshot evidence', () => {
    const result = validateAgentFindings(calls([finding()]), FILES, snapshot);
    expect(result.valid).toEqual([finding()]);
    expect(result.rejected).toEqual([]);
    expect(result.capped).toBe(false);
  });

  it('accepts evidence from any file in the snapshot, not only changed files', () => {
    const result = validateAgentFindings(
      calls([finding({ evidencePath: 'other.ts', evidenceLine: 3 })]),
      FILES,
      snapshot,
    );
    expect(result.valid).toHaveLength(1);
  });

  it('rejects findings with missing or invalid fields', () => {
    const bad: AgentFinding[] = [
      finding({ line: Number.NaN }),
      finding({ title: '   ' }),
      finding({ impact: '' }),
      finding({ evidenceLine: Number.NaN }),
      finding({ suggestedFix: '' }),
    ];
    const result = validateAgentFindings(calls(bad), FILES, snapshot);
    expect(result.valid).toEqual([]);
    expect(result.rejected).toHaveLength(5);
    for (const r of result.rejected) expect(r.reason).toContain('invalid or missing fields');
  });

  it('rejects paths outside the review selection', () => {
    const result = validateAgentFindings(
      calls([finding({ path: 'not/selected.ts' })]),
      FILES,
      snapshot,
    );
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('not among the files selected');
  });

  it('rejects anchors that are not added lines', () => {
    const result = validateAgentFindings(calls([finding({ line: 1 })]), FILES, snapshot);
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('not an added line');
  });

  it('rejects anchors on files whose patch is empty or incomplete', () => {
    const result = validateAgentFindings(
      calls([finding({ path: 'src/binary.bin', line: 1 })]),
      FILES,
      snapshot,
    );
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('not an added line');
  });

  it('rejects duplicate locations, keeping the first', () => {
    const result = validateAgentFindings(
      calls([finding(), finding({ title: 'Second take' })]),
      FILES,
      snapshot,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.title).toBe('Unbounded call');
    expect(result.rejected[0]?.reason).toContain('duplicate');
  });

  it('rejects evidence paths that escape the snapshot or do not exist', () => {
    const cases = [
      finding({ evidencePath: '../outside.ts' }),
      finding({ evidencePath: '/etc/passwd' }),
      finding({ evidencePath: 'src/../..', evidenceLine: 1 }),
      finding({ evidencePath: 'missing.ts' }),
    ];
    const result = validateAgentFindings(calls(cases), FILES, snapshot);
    expect(result.valid).toEqual([]);
    expect(result.rejected).toHaveLength(4);
    const reasons = result.rejected.map((r) => r.reason).join('\n');
    expect(reasons).toContain('safe repository-relative path');
    expect(reasons).toContain('not found in the head snapshot');
  });

  it('rejects evidence lines beyond the end of the file', () => {
    const result = validateAgentFindings(
      calls([finding({ evidencePath: 'other.ts', evidenceLine: 99 })]),
      FILES,
      snapshot,
    );
    expect(result.valid).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('out of range');
  });

  it('accepts an evidence line pointing at a trailing empty line of a file', () => {
    // 'a\nb\nc\n' splits to 4 entries with the final empty string
    const result = validateAgentFindings(
      calls([finding({ evidencePath: 'other.ts', evidenceLine: 4 })]),
      FILES,
      snapshot,
    );
    expect(result.valid).toHaveLength(1);
  });

  it('marks the result capped when more candidates than the limit arrive', () => {
    const many = Array.from({ length: 30 }, (_, i) => finding({ line: 2, title: `t${i}` }));
    const result = validateAgentFindings(calls(many), FILES, snapshot);
    expect(result.capped).toBe(true);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(24);
  });
});
