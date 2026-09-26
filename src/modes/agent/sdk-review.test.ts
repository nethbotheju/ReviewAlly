import * as piSdk from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import type { ActionInputs, RepoRoot } from '../../config/types';
import type { FetchResult, PullRequestInfo } from '../../shared/types';
import { createReviewAgentSession } from './sdk-session';
import {
  buildSdkReviewSystemPrompt,
  buildSdkReviewUserPrompt,
  runSdkInvestigation,
} from './sdk-review';

vi.mock('./sdk-session', () => ({ createReviewAgentSession: vi.fn() }));

const pr: PullRequestInfo = {
  number: 4,
  title: 'Update auth',
  body: 'Reject stale users',
  headSha: 'abc',
};
const fetchResult: FetchResult = {
  files: [
    {
      filename: 'src/auth.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      lines: [{ type: 'add', newLine: 12, content: 'return session.user;' }],
    },
  ],
  totalFiles: 3,
  reviewedFiles: 1,
  truncated: true,
  truncatedReason: 'Reached max-files limit',
};
const inputs = {
  apiType: 'openai',
  apiKey: 'test-only',
  model: 'gpt-4o',
  piTimeoutMs: 1000,
} as ActionInputs;
const root: RepoRoot = { path: '/tmp/snapshot/repo', workDir: '/tmp/snapshot' };

function fakeSession(submit: boolean, finish = true) {
  const dispose = vi.fn();
  vi.mocked(createReviewAgentSession).mockImplementation(
    async (_root, _system, _inputs, options) => {
      const tools = options?.createTools?.(Type, piSdk);
      if (!tools) throw new Error('Missing review tools');
      return {
        session: {
          subscribe: () => () => {},
          messages: [{ role: 'assistant', stopReason: 'stop' }],
          abort: vi.fn(),
          prompt: async () => {
            if (submit) {
              await tools
                .find((tool) => tool.name === 'submit_finding')!
                .execute(
                  'call-1',
                  {
                    path: 'src/auth.ts',
                    line: 12,
                    title: 'Skipped check',
                    severity: 'medium',
                    impact: 'Expired sessions remain valid.',
                    evidencePath: 'src/auth.ts',
                    evidenceLine: 12,
                    evidence: 'Return bypasses validation.',
                    suggestedFix: 'Check expiry first.',
                  },
                  undefined,
                  undefined,
                  {} as never,
                );
            }
            if (finish) {
              await tools
                .find((tool) => tool.name === 'finish_review')!
                .execute(
                  'call-2',
                  { summary: 'One auth path reviewed.', limitations: ['Two files not reviewed.'] },
                  undefined,
                  undefined,
                  {} as never,
                );
            }
          },
        },
        dispose,
      } as unknown as Awaited<ReturnType<typeof createReviewAgentSession>>;
    },
  );
  return dispose;
}

describe('pi SDK investigation', () => {
  it('does not require JSON output and describes selected-file coverage', () => {
    const system = buildSdkReviewSystemPrompt(inputs);
    expect(system).toContain('submit_finding');
    expect(system).toContain('finish_review');
    expect(system).not.toContain('fenced json');
    expect(buildSdkReviewUserPrompt(pr, fetchResult)).toContain('Selected 1 of 3 changed files');
  });

  it('collects tool-submitted candidate findings and disposes the session', async () => {
    const dispose = fakeSession(true);
    const result = await runSdkInvestigation(pr, fetchResult, root, inputs);
    expect(result.findings).toHaveLength(1);
    expect(result.assessment?.limitations).toEqual(['Two files not reviewed.']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects an incomplete investigation', async () => {
    const dispose = fakeSession(true, false);
    await expect(runSdkInvestigation(pr, fetchResult, root, inputs)).rejects.toThrow(
      'without finish_review',
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('accepts a completed investigation with no findings', async () => {
    const dispose = fakeSession(false);
    const result = await runSdkInvestigation(pr, fetchResult, root, inputs);
    expect(result.findings).toEqual([]);
    expect(result.assessment).toBeDefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
