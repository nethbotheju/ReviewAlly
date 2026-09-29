import { describe, it, expect, vi, type Mock } from 'vitest';
import { fetchFileContents, postReview, reactToComment, type OctokitLike } from './api';
import type { ReviewComment } from '../shared/types';

// --- fetchFileContents ---

function makeOctokit(respond: (path: string) => Promise<string> | string) {
  return {
    request: vi.fn().mockImplementation(async (route: string, opts: { path: string }) => {
      if (!route.includes('/contents/')) throw new Error(`unexpected route ${route}`);
      return { data: await respond(opts.path) };
    }),
  } as unknown as OctokitLike;
}

function asRequestMock(octokit: OctokitLike): Mock {
  return octokit.request as unknown as Mock;
}

describe('fetchFileContents', () => {
  it('returns empty string when paths is empty', async () => {
    const octokit = makeOctokit(async () => 'x');
    const out = await fetchFileContents(octokit, 'o', 'r', 'main', [], {
      maxBytes: 100,
      maxFiles: 3,
    });
    expect(out).toBe('');
    expect(asRequestMock(octokit)).not.toHaveBeenCalled();
  });

  it('fetches and concatenates each path with a header', async () => {
    const octokit = makeOctokit(async (p) => `body of ${p}`);
    const out = await fetchFileContents(octokit, 'o', 'r', 'main', ['AGENTS.md', 'README.md'], {
      maxBytes: 1000,
      maxFiles: 3,
    });
    expect(out).toContain('## AGENTS.md');
    expect(out).toContain('body of AGENTS.md');
    expect(out).toContain('## README.md');
    expect(out).toContain('body of README.md');
  });

  it('truncates each file to maxBytes', async () => {
    const octokit = makeOctokit(async () => 'a'.repeat(100));
    const out = await fetchFileContents(octokit, 'o', 'r', 'main', ['A.md'], {
      maxBytes: 10,
      maxFiles: 3,
    });
    expect(out).toContain('a'.repeat(10) + '…');
  });

  it('skips 404s and continues with the remaining paths', async () => {
    const octokit = {
      request: vi.fn().mockImplementation(async (_route: string, opts: { path: string }) => {
        if (opts.path === 'missing.md') {
          const err = new Error('Not Found') as Error & { status: number };
          err.status = 404;
          throw err;
        }
        return { data: `body of ${opts.path}` };
      }),
    } as unknown as OctokitLike;
    const out = await fetchFileContents(octokit, 'o', 'r', 'main', ['missing.md', 'AGENTS.md'], {
      maxBytes: 1000,
      maxFiles: 3,
    });
    expect(out).not.toContain('missing.md');
    expect(out).toContain('body of AGENTS.md');
  });

  it('returns empty string when every path 404s', async () => {
    const octokit = {
      request: vi.fn().mockImplementation(async () => {
        const err = new Error('Not Found') as Error & { status: number };
        err.status = 404;
        throw err;
      }),
    } as unknown as OctokitLike;
    const out = await fetchFileContents(octokit, 'o', 'r', 'main', ['a.md', 'b.md'], {
      maxBytes: 1000,
      maxFiles: 3,
    });
    expect(out).toBe('');
  });

  it('caps the number of files fetched at maxFiles', async () => {
    const octokit = makeOctokit(async (p) => `body of ${p}`);
    await fetchFileContents(octokit, 'o', 'r', 'main', ['a.md', 'b.md', 'c.md', 'd.md'], {
      maxBytes: 1000,
      maxFiles: 2,
    });
    expect(asRequestMock(octokit)).toHaveBeenCalledTimes(2);
  });
});

// --- postReview ---

interface OctokitMocks {
  createReview: Mock;
  createReaction: Mock;
}

function makePostingOctokit(overrides: Partial<OctokitMocks> = {}): OctokitLike {
  const mocks: OctokitMocks = {
    createReview: overrides.createReview ?? vi.fn().mockResolvedValue({ data: { id: 1 } }),
    createReaction: overrides.createReaction ?? vi.fn().mockResolvedValue({ data: { id: 1 } }),
  };
  return {
    rest: {
      pulls: { createReview: mocks.createReview },
      reactions: { createForIssueComment: mocks.createReaction },
    },
  } as unknown as OctokitLike;
}

describe('postReview', () => {
  it('maps ReviewComment to the octokit shape and sends the review', async () => {
    const octokit = makePostingOctokit();
    const comments: ReviewComment[] = [
      { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'Fix this' },
    ];
    await postReview(octokit, 'o', 'r', 1, 'sha', 'body', comments);
    expect(octokit.rest.pulls.createReview as unknown as Mock).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 1,
      commit_id: 'sha',
      event: 'COMMENT',
      body: 'body',
      comments: [{ path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'Fix this' }],
    });
  });

  it('sends an empty comments array when none provided', async () => {
    const octokit = makePostingOctokit();
    await postReview(octokit, 'o', 'r', 1, 'sha', 'body', []);
    expect(octokit.rest.pulls.createReview as unknown as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] }),
    );
  });
});

describe('reactToComment', () => {
  it('sends a reaction with the given content', async () => {
    const octokit = makePostingOctokit();
    await reactToComment(octokit, 'o', 'r', 42, 'eyes');
    expect(octokit.rest.reactions.createForIssueComment as unknown as Mock).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 42,
      content: 'eyes',
    });
  });

  it('swallows errors instead of throwing', async () => {
    const octokit = makePostingOctokit({
      createReaction: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(reactToComment(octokit, 'o', 'r', 42, '+1')).resolves.toBeUndefined();
  });
});

// --- applyDiffBudget / fetchChangedFiles selection ---

import { applyDiffBudget, fetchChangedFiles } from './api';
import type { ActionInputs } from '../config/types';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiType: 'openai',
    apiKey: 'sk-test',
    model: 'm',
    githubToken: 'ghp_test',
    triggerComment: '/reviewally',
    triggerLabel: 'reviewally',
    autoReview: false,
    maxFiles: 20,
    maxDiffLines: 3000,
    useDefaultExcludes: true,
    reviewMode: 'standard',
    excludePatterns: [],
    agentTarballMaxMb: 200,
    contextDocs: [],
    piVersion: '0.82.1',
    piTimeoutMs: 600000,
    piLog: 'compact',
    piThinking: 'off',
    ...overrides,
  };
}

function patchFile(filename: string, additions: number) {
  const lines = Array.from({ length: additions }, (_, i) => ({
    type: 'add',
    newLine: i + 1,
    content: `+ line ${i + 1}`,
  }));
  return {
    filename,
    status: 'modified',
    additions,
    deletions: 0,
    patch: lines.map((l) => `+${l.content}`).join('\n'),
  };
}

describe('applyDiffBudget', () => {
  it('keeps everything under both caps', () => {
    const items = [patchFile('a.ts', 10), patchFile('b.ts', 10)];
    const result = applyDiffBudget(items, { maxFiles: 20, maxDiffLines: 3000 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.truncatedReason).toBeUndefined();
  });

  it('stops at the max-files cap and reports the reason', () => {
    const items = [patchFile('a.ts', 1), patchFile('b.ts', 1), patchFile('c.ts', 1)];
    const result = applyDiffBudget(items, { maxFiles: 2, maxDiffLines: 3000 });
    expect(result.files.map((f) => f.filename)).toEqual(['a.ts', 'b.ts']);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('Reached max-files limit (2)');
  });

  it('stops at the max-diff-lines cap but never yields an empty selection', () => {
    const items = [patchFile('a.ts', 5000), patchFile('b.ts', 1)];
    const result = applyDiffBudget(items, { maxFiles: 20, maxDiffLines: 3000 });
    expect(result.files.map((f) => f.filename)).toEqual(['a.ts']);
    expect(result.truncatedReason).toBe('Reached max-diff-lines limit (3000)');
  });
});

describe('fetchChangedFiles selection', () => {
  function paginateOctokit(files: unknown[]) {
    return {
      paginate: vi.fn().mockResolvedValue(files),
      rest: { pulls: { listFiles: vi.fn() } },
    } as unknown as OctokitLike;
  }

  it('keeps every candidate file in agent mode regardless of caps', async () => {
    const files = Array.from({ length: 25 }, (_, i) => patchFile(`f${i}.ts`, 500));
    const result = await fetchChangedFiles(
      paginateOctokit(files),
      'o',
      'r',
      1,
      makeInputs({ reviewMode: 'agent', maxFiles: 2, maxDiffLines: 10 }),
    );
    expect(result.files).toHaveLength(25);
    expect(result.truncated).toBe(false);
    expect(result.truncatedReason).toBeUndefined();
    expect(result.totalFiles).toBe(25);
    expect(result.reviewedFiles).toBe(25);
  });

  it('applies the budget in standard mode', async () => {
    const files = Array.from({ length: 5 }, (_, i) => patchFile(`f${i}.ts`, 1));
    const result = await fetchChangedFiles(
      paginateOctokit(files),
      'o',
      'r',
      1,
      makeInputs({ reviewMode: 'standard', maxFiles: 2, maxDiffLines: 3000 }),
    );
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('Reached max-files limit (2)');
  });
});
