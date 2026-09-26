import * as core from '@actions/core';
import type { RepoRoot } from '../../config/types';
import { fetchPullRequest, postReview, type OctokitLike } from '../../github/api';
import type { FetchResult, PullRequestInfo } from '../../shared/types';
import { validateAgentFindings, type ValidatedReview } from './findings';
import { formatAgentReview } from './format-review';
import type { AgentInvestigation } from './review-tools';

export async function publishAgentReview(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pr: PullRequestInfo,
  fetchResult: FetchResult,
  snapshot: RepoRoot,
  investigation: AgentInvestigation,
): Promise<ValidatedReview> {
  const validated = validateAgentFindings(investigation, fetchResult, snapshot);
  if (validated.rejected.length > 0) {
    core.warning(`${validated.rejected.length} agent finding(s) failed host validation.`);
  }
  const currentPr = await fetchPullRequest(octokit, owner, repo, pr.number);
  if (currentPr.headSha !== pr.headSha) {
    throw new Error(
      'PR head changed during the agent review; stale inline comments were not posted.',
    );
  }
  await postReview(
    octokit,
    owner,
    repo,
    pr.number,
    pr.headSha,
    formatAgentReview(pr, fetchResult, investigation, validated),
    validated.comments,
  );
  return validated;
}
