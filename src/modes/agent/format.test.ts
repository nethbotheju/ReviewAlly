import { describe, it, expect } from 'vitest';
import type { ChangedFile } from '../../shared/types';
import type { AgentFinding, AgentFinish } from './tools';
import { formatAgentReview, formatFindingComment, type AgentReviewFormatInput } from './format';
import type { RejectedFinding } from './validate';

const FILES: ChangedFile[] = [
  {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    lines: [
      { type: 'context', oldLine: 1, newLine: 1, content: 'ctx' },
      { type: 'add', newLine: 2, content: 'const x = unbounded();' },
    ],
  },
  {
    filename: 'src/b.ts',
    status: 'added',
    additions: 5,
    deletions: 0,
    lines: [],
  },
];

const FINDING: AgentFinding = {
  path: 'src/a.ts',
  line: 2,
  title: 'Unbounded call',
  severity: 'high',
  impact: 'Can throw on empty input',
  evidencePath: 'src/a.ts',
  evidenceLine: 2,
  evidence: 'unbounded() has no guard',
  suggestedFix: 'Guard the input',
};

const FINISH: AgentFinish = {
  summary: 'The change is small and focused.',
  limitations: ['Could not run the test suite'],
  fileSummaries: [{ path: 'src/a.ts', description: 'Adds the unbounded call' }],
};

function input(overrides: Partial<AgentReviewFormatInput> = {}): AgentReviewFormatInput {
  return {
    status: 'completed',
    finish: FINISH,
    validFindings: [FINDING],
    rejected: [],
    capped: false,
    files: FILES,
    inspectedPaths: ['src/a.ts'],
    selectionTruncated: false,
    toolErrors: [],
    uncompletedCalls: 0,
    headSha: 'abc123def4567890',
    postInline: true,
    ...overrides,
  };
}

describe('formatAgentReview', () => {
  it('renders a completed review with findings as inline comments', () => {
    const { body, comments } = formatAgentReview(input());
    expect(body).toContain('### 🤖 ReviewAlly agent review');
    expect(body).toContain('**Completed** — 1 finding(s) posted as inline review comments');
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>Review walkthrough</summary>');
    expect(body).toContain('| File | Change | Diff inspected | Summary |');
    expect(body).toContain('`src/a.ts`');
    expect(body).toContain('Adds the unbounded call');
    expect(body).toContain('#### Diff inspection');
    expect(body).toContain('1 of 2 reviewed file patches');
    expect(body).toContain('#### Assessment');
    expect(body).toContain('The change is small and focused.');
    expect(body).toContain('#### Limitations');
    expect(body).toContain('- Could not run the test suite');
    expect(body).toContain('**Reviewed head:** `abc123def4567890`');
    expect(body).not.toContain('#### Not posted');

    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual({
      path: 'src/a.ts',
      line: 2,
      side: 'RIGHT',
      body: formatFindingComment(FINDING),
    });
  });

  it('distinguishes a completed no-findings review', () => {
    const { body, comments } = formatAgentReview(input({ validFindings: [] }));
    expect(body).toContain('**Completed — no findings.**');
    expect(comments).toEqual([]);
  });

  it('marks a partial review when finish_review was never called', () => {
    const { body } = formatAgentReview(input({ status: 'partial', finish: undefined }));
    expect(body).toContain('**Partial review** — the agent did not call finish_review');
    expect(body).toContain('_No summary recorded — the review did not complete._');
  });

  it('marks a partial review when tool calls were interrupted', () => {
    const { body } = formatAgentReview(input({ status: 'partial', uncompletedCalls: 2 }));
    expect(body).toContain('2 tool call(s) were interrupted');
  });

  it('posts no inline comments and explains when the head is stale', () => {
    const { body, comments } = formatAgentReview(input({ status: 'stale', postInline: false }));
    expect(body).toContain('**Partial review — the PR head moved.**');
    expect(body).toContain('No inline findings were posted.');
    expect(comments).toEqual([]);
  });

  it('reflects rejected candidates, tool errors, caps, and truncated selection', () => {
    const rejected: RejectedFinding[] = [
      { path: 'src/b.ts', line: 7, title: 'Dup', reason: 'duplicate location — already recorded' },
    ];
    const { body } = formatAgentReview(
      input({
        rejected,
        capped: true,
        toolErrors: ['get_diff: failed to load the review diff data'],
        selectionTruncated: true,
        truncatedReason: 'Reached max-files limit (20)',
      }),
    );
    expect(body).toContain('#### Not posted');
    expect(body).toContain('`src/b.ts:7` — duplicate location');
    expect(body).toContain('Tool error: get_diff: failed to load');
    expect(body).toContain('finding limit reached');
    expect(body).toContain('_Incomplete coverage: the file selection was truncated');
  });

  it('falls back to +adds -dels when a file has no model summary', () => {
    const { body } = formatAgentReview(input({ finish: { ...FINISH, fileSummaries: [] } }));
    expect(body).toContain('+2 -1');
    expect(body).toContain('+5 -0');
  });
});

describe('formatFindingComment', () => {
  it('shows severity, title, impact, evidence, and suggested fix', () => {
    const out = formatFindingComment(FINDING);
    expect(out).toContain('**[High] Unbounded call**');
    expect(out).toContain('**Impact:** Can throw on empty input');
    expect(out).toContain('**Evidence** `src/a.ts:2`');
    expect(out).toContain('> unbounded() has no guard');
    expect(out).toContain('**Suggested fix:** Guard the input');
  });

  it('maps severities to labels', () => {
    expect(formatFindingComment({ ...FINDING, severity: 'medium' })).toContain('[Medium]');
    expect(formatFindingComment({ ...FINDING, severity: 'low' })).toContain('[Low]');
  });
});
