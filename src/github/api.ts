import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import type { ActionInputs } from '../config/types';
import type { ChangedFile, FetchResult, PullRequestInfo, ReviewComment } from '../shared/types';
import { annotatePatch } from '../shared/patch';
import { isExcluded, resolveExcludes } from '../shared/util';

export type OctokitLike = ReturnType<typeof getOctokit>;

// --- Pull request ---

export async function fetchPullRequest(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestInfo> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    headSha: data.head.sha,
  };
}

export async function fetchChangedFiles(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pullNumber: number,
  inputs: ActionInputs,
): Promise<FetchResult> {
  const all = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const excludes = resolveExcludes(inputs);

  const candidates = all.filter((f) => {
    if (f.status === 'removed') return false;
    if (!f.patch) return false;
    if (isExcluded(f.filename, excludes)) return false;
    return true;
  });

  // Agent mode reads diffs on demand via the get_diff tool (never the
  // prompt), so every candidate file stays inspectable. Standard mode embeds
  // the diff in the prompt and keeps the size budget.
  const budgeted =
    inputs.reviewMode === 'agent'
      ? { files: candidates, truncated: false, truncatedReason: undefined as string | undefined }
      : applyDiffBudget(candidates, {
          maxFiles: inputs.maxFiles,
          maxDiffLines: inputs.maxDiffLines,
        });

  const files: ChangedFile[] = budgeted.files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    lines: annotatePatch(f.patch as string),
  }));

  core.info(
    `Found ${all.length} changed file(s); ${candidates.length} reviewable; reviewing ${files.length}.`,
  );

  return {
    files,
    totalFiles: all.length,
    reviewedFiles: files.length,
    truncated: budgeted.truncated,
    truncatedReason: budgeted.truncatedReason,
  };
}

export interface DiffBudget {
  maxFiles: number;
  maxDiffLines: number;
}

/**
 * Apply the standard-mode selection budget: stop before the file that would
 * exceed either cap. A single oversized first file is still included so the
 * review never ends up empty.
 */
export function applyDiffBudget<T extends { additions: number }>(
  items: T[],
  budget: DiffBudget,
): { files: T[]; truncated: boolean; truncatedReason?: string } {
  const files: T[] = [];
  let addedLines = 0;
  for (const item of items) {
    if (files.length >= budget.maxFiles) {
      return {
        files,
        truncated: true,
        truncatedReason: `Reached max-files limit (${budget.maxFiles})`,
      };
    }
    const nextTotal = addedLines + item.additions;
    if (nextTotal > budget.maxDiffLines && files.length > 0) {
      return {
        files,
        truncated: true,
        truncatedReason: `Reached max-diff-lines limit (${budget.maxDiffLines})`,
      };
    }
    addedLines = nextTotal;
    files.push(item);
  }
  return { files, truncated: false };
}

// --- File contents ---

export interface TarballResult {
  buffer: Buffer;
  contentLengthMb: number | null;
}

/**
 * Download a repo tarball at a ref via the octokit client (GHE-aware).
 * Returns the raw bytes plus the Content-Length in MB (for size guards).
 */
export async function downloadTarball(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  ref: string,
): Promise<TarballResult> {
  const { data, headers } = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref });

  if (!data) {
    throw new Error('Empty response from downloadTarballArchive.');
  }
  // Older octokit returns Buffer; v6 (native fetch) returns ArrayBuffer. Normalize.
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

  const clHeader = (headers as Record<string, string | undefined>)['content-length'];
  const contentLengthMb = clHeader ? Number(clHeader) / (1024 * 1024) : null;

  return { buffer, contentLengthMb };
}

/**
 * Fetch one or more text files (e.g. project docs) from the repo at a ref.
 * Uses the Contents API with the raw media type (GHE-aware). Missing files are skipped.
 */
export async function fetchFileContents(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  ref: string,
  paths: string[],
  opts: { maxBytes: number; maxFiles: number },
): Promise<string> {
  if (!paths.length) return '';

  const parts: string[] = [];
  let count = 0;

  for (const rawPath of paths.slice(0, opts.maxFiles)) {
    const name = rawPath.trim();
    if (!name) continue;
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: name,
        ref,
        mediaType: { format: 'raw' },
      });

      const text = typeof data === 'string' ? data : String(data);
      const body = text.length > opts.maxBytes ? `${text.slice(0, opts.maxBytes)}…` : text;
      parts.push(`## ${name}\n\n${body}`);
      count++;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) {
        core.debug(`Failed to fetch ${name}: ${(err as Error).message}`);
      }
    }
  }

  return count === 0 ? '' : parts.join('\n\n');
}

// --- Posting ---

export async function postReview(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  body: string,
  comments: ReviewComment[],
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: headSha,
    event: 'COMMENT',
    body,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    })),
  });
}

export async function reactToComment(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  commentId: number,
  content: 'eyes' | '+1' | 'rocket',
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch (err) {
    core.warning(`Could not add reaction to comment: ${(err as Error).message}`);
  }
}
