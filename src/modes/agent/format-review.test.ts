import { describe, expect, it } from 'vitest';
import type { FetchResult, PullRequestInfo } from '../../shared/types';
import type { AgentInvestigation } from './review-tools';
import { formatAgentReview } from './format-review';

const pr: PullRequestInfo = { number: 1, title: 'Fix', body: null, headSha: 'abc123' };
const fetchResult: FetchResult = {
  files: [
    {
      filename: 'src/auth.ts',
      status: 'modified',
      additions: 1,
      deletions: 2,
      lines: [{ type: 'add', newLine: 3, content: 'const value = 1;' }],
    },
  ],
  totalFiles: 2,
  reviewedFiles: 1,
  truncated: true,
  truncatedReason: 'Reached max-files limit',
};
const investigation: AgentInvestigation = {
  findings: [],
  assessment: { summary: 'One concern was investigated.', limitations: ['No runtime tests.'] },
  openedDiffs: [],
};

describe('formatAgentReview', () => {
  it('renders a walkthrough with explicit partial scope and real checks', () => {
    const body = formatAgentReview(pr, fetchResult, investigation, { comments: [], rejected: [] });
    expect(body).toContain('<summary>Review walkthrough</summary>');
    expect(body).toContain('this review is partial');
    expect(body).toContain('1 of 2 changed files selected (partial)');
    expect(body).toContain('Not run by ReviewAlly');
    expect(body).toContain('Reviewed head: `abc123`');
  });

  it('does not claim a clean review when every candidate was rejected', () => {
    const body = formatAgentReview(pr, fetchResult, investigation, {
      comments: [],
      rejected: [{ path: 'src/auth.ts', line: 3, reason: 'stale' }],
    });
    expect(body).toContain('not a clean review');
    expect(body).toContain('1 proposed finding(s) failed');
  });
});
