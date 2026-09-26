import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OctokitLike } from '../../github/api';
import type { RepoRoot } from '../../config/types';
import type { FetchResult, PullRequestInfo } from '../../shared/types';
import type { AgentInvestigation } from './review-tools';
import { publishAgentReview } from './post';

const pr: PullRequestInfo = { number: 7, title: 'Fix', body: null, headSha: 'reviewed-sha' };
const fetchResult: FetchResult = {
  files: [
    {
      filename: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      lines: [{ type: 'add', newLine: 1, content: 'return value;' }],
    },
  ],
  totalFiles: 1,
  reviewedFiles: 1,
  truncated: false,
};
const investigation: AgentInvestigation = {
  assessment: { summary: 'Issue found.', limitations: [] },
  openedDiffs: ['src/a.ts'],
  findings: [
    {
      path: 'src/a.ts',
      line: 1,
      severity: 'medium',
      title: 'Missing check',
      impact: 'A bad value is returned.',
      evidencePath: 'src/a.ts',
      evidenceLine: 1,
      evidence: 'No check on this line.',
      suggestedFix: 'Check value first.',
    },
  ],
};

async function withSnapshot(run: (root: RepoRoot) => Promise<void>) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-post-test-'));
  const repoRoot = { path: path.join(workDir, 'repo'), workDir };
  fs.mkdirSync(path.join(repoRoot.path, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot.path, 'src/a.ts'), 'return value;\n');
  try {
    await run(repoRoot);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function octokit(headSha: string) {
  const get = vi.fn().mockResolvedValue({
    data: {
      number: pr.number,
      title: pr.title,
      body: null,
      head: { sha: headSha },
    },
  });
  const createReview = vi.fn().mockResolvedValue({ data: { id: 1 } });
  return {
    client: { rest: { pulls: { get, createReview } } } as unknown as OctokitLike,
    createReview,
  };
}

describe('publishAgentReview', () => {
  it('posts one review containing a walkthrough and an inline finding on the reviewed SHA', async () => {
    await withSnapshot(async (root) => {
      const { client, createReview } = octokit(pr.headSha);
      const validated = await publishAgentReview(
        client,
        'o',
        'r',
        pr,
        fetchResult,
        root,
        investigation,
      );
      expect(validated.comments).toHaveLength(1);
      expect(createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_id: 'reviewed-sha',
          event: 'COMMENT',
          body: expect.stringContaining('Review walkthrough'),
          comments: [expect.objectContaining({ path: 'src/a.ts', line: 1, side: 'RIGHT' })],
        }),
      );
    });
  });

  it('does not post stale comments when the PR head has moved', async () => {
    await withSnapshot(async (root) => {
      const { client, createReview } = octokit('new-sha');
      await expect(
        publishAgentReview(client, 'o', 'r', pr, fetchResult, root, investigation),
      ).rejects.toThrow('head changed');
      expect(createReview).not.toHaveBeenCalled();
    });
  });

  it('marks failed validation and does not silently post an invalid position', async () => {
    await withSnapshot(async (root) => {
      const { client, createReview } = octokit(pr.headSha);
      await publishAgentReview(client, 'o', 'r', pr, fetchResult, root, {
        ...investigation,
        findings: [{ ...investigation.findings[0]!, line: 3 }],
      });
      expect(createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: [],
          body: expect.stringContaining('not a clean review'),
        }),
      );
    });
  });
});
