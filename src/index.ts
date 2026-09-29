import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { getRawInputs } from './config/inputs';
import { repoVariablesFromEnv, resolveInputs, configSummaryRows } from './config/variables';
import { resolveTrigger } from './github/trigger';
import { fetchAppToken, AppNotInstalledError } from './github/app-token';
import {
  fetchFileContents,
  fetchPullRequest,
  fetchChangedFiles,
  applyDiffBudget,
  postReview,
  reactToComment,
} from './github/api';
import { buildAgentSystemPrompt, buildSystemPrompt, buildUserPrompt } from './shared/prompt';
import { parseReview } from './shared/parse';
import { formatNoChanges, formatRepairWarning, formatReview } from './shared/format';
import { runStandardReview } from './modes/standard/runner';
import { createModel } from './modes/standard/models';
import { runAgentReview } from './modes/agent/runner';
import { formatAgentReview, type AgentReviewStatus } from './modes/agent/format';
import { validateAgentFindings } from './modes/agent/validate';
import {
  prepareRepoSnapshot,
  buildRepoTree,
  cleanupRepoSnapshot,
  RepoTooLargeError,
} from './modes/agent/snapshot';
import type { ActionInputs, RepoRoot } from './config/types';

async function run(): Promise<void> {
  let repoRoot: RepoRoot | undefined;
  let repaired = false;
  let modelResponse = '';

  try {
    const raw = getRawInputs();
    core.setSecret(raw.apiKey);

    const config = resolveInputs(raw, repoVariablesFromEnv());
    const inputs = config.inputs;

    const trigger = resolveTrigger(inputs);
    if (!trigger.run || !trigger.review) {
      core.info(`Skipping: ${trigger.reason}`);
      return;
    }

    core.summary.addTable(configSummaryRows(config)).write();

    const { owner, repo, pullNumber, commentId } = trigger.review;

    // Branded bot: swap the workflow identity for the ReviewAlly App identity
    // when a minter endpoint is configured. Falls back gracefully.
    let githubToken = inputs.githubToken;
    if (inputs.appTokenUrl) {
      try {
        const appToken = await fetchAppToken(
          inputs.appTokenUrl,
          inputs.githubToken,
          `${owner}/${repo}`,
        );
        core.setSecret(appToken.token);
        githubToken = appToken.token;
        core.info(`Using ReviewAlly app token (expires ${appToken.expiresAt ?? 'soon'}).`);
      } catch (err) {
        if (err instanceof AppNotInstalledError) {
          core.info(
            `ReviewAlly app is not installed on ${owner}/${repo} — install it at https://github.com/apps/reviewally for branded reviews. Posting as the default workflow identity.`,
          );
        } else {
          core.warning(
            `Branded bot unavailable (${(err as Error).message}); this looks like a minter or configuration issue rather than a missing installation — check app-token-url. Posting as the default workflow identity.`,
          );
        }
      }
    }

    const octokit = getOctokit(githubToken);

    if (commentId) await reactToComment(octokit, owner, repo, commentId, 'eyes');

    const pr = await fetchPullRequest(octokit, owner, repo, pullNumber);
    core.info(`Reviewing PR #${pullNumber}: ${pr.title}`);

    const fetchResult = await fetchChangedFiles(octokit, owner, repo, pullNumber, inputs);
    if (fetchResult.files.length === 0) {
      await postReview(octokit, owner, repo, pullNumber, pr.headSha, formatNoChanges(), []);
      core.info('No reviewable changes; posted a skip notice.');
      if (commentId) await reactToComment(octokit, owner, repo, commentId, 'rocket');
      return;
    }

    const contextDocs = await fetchFileContents(
      octokit,
      owner,
      repo,
      pr.headSha,
      inputs.contextDocs,
      {
        maxBytes: 10000,
        maxFiles: 3,
      },
    );

    // Whether we actually run agent mode (may degrade if tarball is too large)
    let useAgent = inputs.reviewMode === 'agent';

    if (useAgent) {
      try {
        repoRoot = await prepareRepoSnapshot(
          octokit,
          owner,
          repo,
          pr.headSha,
          inputs.agentTarballMaxMb,
        );
      } catch (err) {
        if (err instanceof RepoTooLargeError) {
          core.warning(err.message);
          useAgent = false;
          // The selection was uncapped for agent mode; re-apply the standard
          // budget so the degraded prompt stays bounded.
          const budgeted = applyDiffBudget(fetchResult.files, {
            maxFiles: inputs.maxFiles,
            maxDiffLines: inputs.maxDiffLines,
          });
          fetchResult.files = budgeted.files;
          fetchResult.reviewedFiles = budgeted.files.length;
          fetchResult.truncated = fetchResult.truncated || budgeted.truncated;
          fetchResult.truncatedReason = budgeted.truncatedReason ?? fetchResult.truncatedReason;
        } else {
          throw err;
        }
      }
    }

    // Build prompts
    const tree = useAgent && repoRoot ? buildRepoTree(repoRoot.path, inputs) : undefined;
    const promptInputs: ActionInputs = useAgent ? inputs : { ...inputs, reviewMode: 'standard' };
    const systemPrompt = useAgent
      ? buildAgentSystemPrompt(promptInputs)
      : buildSystemPrompt(promptInputs);
    const userPrompt = buildUserPrompt(
      pr,
      fetchResult.files,
      { docs: contextDocs, tree },
      useAgent,
    );

    // Run review
    const agentResult =
      useAgent && repoRoot
        ? await runAgentReview(systemPrompt, userPrompt, repoRoot, inputs, fetchResult)
        : undefined;
    const reviewResult = agentResult
      ? agentResult
      : await runStandardReview(createModel(inputs), systemPrompt, userPrompt);

    core.info(
      `Review done. tokens in=${reviewResult.inputTokens} out=${reviewResult.outputTokens} tot=${reviewResult.totalTokens} steps=${reviewResult.steps}`,
    );

    if (agentResult && repoRoot) {
      modelResponse = agentResult.text;
      // The PR must not have moved while the agent ran: inline findings anchor
      // to the reviewed head, so a stale head posts no inline comments.
      const current = await fetchPullRequest(octokit, owner, repo, pullNumber);
      const stale = current.headSha !== pr.headSha;
      if (stale) {
        core.warning(
          `PR head moved during the review (${pr.headSha.slice(0, 8)} → ${current.headSha.slice(0, 8)}); posting a partial review without inline findings.`,
        );
      }

      const toolCalls = agentResult.toolCalls;
      const status: AgentReviewStatus = stale
        ? 'stale'
        : toolCalls.finish && !agentResult.timedOut
          ? 'completed'
          : 'partial';

      const validation = validateAgentFindings(toolCalls, fetchResult.files, repoRoot.path);
      const formatted = formatAgentReview({
        status,
        finish: toolCalls.finish,
        validFindings: validation.valid,
        rejected: validation.rejected,
        capped: validation.capped,
        files: fetchResult.files,
        inspectedPaths: toolCalls.inspectedPaths,
        selectionTruncated: fetchResult.truncated,
        truncatedReason: fetchResult.truncatedReason,
        toolErrors: toolCalls.toolErrors,
        uncompletedCalls: toolCalls.uncompletedCalls,
        timedOut: agentResult.timedOut,
        headSha: pr.headSha,
        postInline: !stale,
      });

      await postReview(
        octokit,
        owner,
        repo,
        pullNumber,
        pr.headSha,
        formatted.body,
        formatted.comments,
      );
      core.setOutput('summary', toolCalls.finish?.summary || 'Agent review posted.');
      core.info(
        `Posted agent review: status=${status}, ${formatted.comments.length} inline finding(s), ` +
          `${validation.rejected.length} rejected.`,
      );
    } else {
      // Parse, format, post
      modelResponse = reviewResult.text;
      const doc = parseReview(reviewResult.text, {
        onRepair: () => {
          repaired = true;
        },
      });
      const body = formatReview(doc, fetchResult.files);
      await postReview(octokit, owner, repo, pullNumber, pr.headSha, body, []);
      if (repaired) {
        core.warning(formatRepairWarning(reviewResult.text));
      }
      core.setOutput('summary', doc.solution || doc.background);
    }

    core.info('Posted review.');
    if (commentId) await reactToComment(octokit, owner, repo, commentId, '+1');
  } catch (err) {
    const e = err as Error;
    if (modelResponse) {
      core.startGroup('Full model response');
      core.info(modelResponse);
      core.endGroup();
    }
    const repairNote = repaired ? ' (note: the model response had required JSON repair)' : '';
    core.setFailed(
      `ReviewAlly review failed: ${e.message}${repairNote}${e.stack ? `\n${e.stack}` : ''}`,
    );
  } finally {
    if (repoRoot) {
      try {
        cleanupRepoSnapshot(repoRoot);
      } catch {
        /* best-effort */
      }
    }
  }
}

run();
