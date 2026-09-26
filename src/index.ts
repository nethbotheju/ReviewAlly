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
  postReview,
  reactToComment,
} from './github/api';
import { buildSystemPrompt, buildUserPrompt } from './shared/prompt';
import { parseReview } from './shared/parse';
import { formatNoChanges, formatRepairWarning, formatReview } from './shared/format';
import { runStandardReview } from './modes/standard/runner';
import { createModel } from './modes/standard/models';
import { runSdkInvestigation } from './modes/agent/sdk-review';
import { publishAgentReview } from './modes/agent/post';
import { PI_SDK_VERSION } from './modes/agent/sdk-install';
import {
  prepareRepoSnapshot,
  buildRepoTree,
  cleanupRepoSnapshot,
  RepoTooLargeError,
} from './modes/agent/snapshot';
import type { RepoRoot } from './config/types';

async function run(): Promise<void> {
  let repoRoot: RepoRoot | undefined;
  let repaired = false;
  let modelResponse = '';

  try {
    const raw = getRawInputs();
    core.setSecret(raw.apiKey);
    core.setSecret(raw.githubToken);

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
        } else {
          throw err;
        }
      }
    }

    if (useAgent && repoRoot) {
      if (inputs.piVersion !== PI_SDK_VERSION) {
        throw new Error(
          `Agent mode requires the pinned pi SDK ${PI_SDK_VERSION}; received pi-version=${inputs.piVersion}.`,
        );
      }
      const beforeReview = await fetchPullRequest(octokit, owner, repo, pullNumber);
      if (beforeReview.headSha !== pr.headSha) {
        throw new Error(
          'PR head changed while preparing the agent snapshot. Run the review again.',
        );
      }
      const investigation = await runSdkInvestigation(pr, fetchResult, repoRoot, inputs, {
        docs: contextDocs,
        tree: buildRepoTree(repoRoot.path, inputs),
        traceSecrets: [inputs.githubToken, githubToken],
      });
      const validated = await publishAgentReview(
        octokit,
        owner,
        repo,
        pr,
        fetchResult,
        repoRoot,
        investigation,
      );
      core.setOutput('summary', investigation.assessment!.summary);
      core.info(`Posted agent review with ${validated.comments.length} inline finding(s).`);
      if (commentId) await reactToComment(octokit, owner, repo, commentId, '+1');
      return;
    }

    const systemPrompt = buildSystemPrompt(inputs);
    const userPrompt = buildUserPrompt(pr, fetchResult.files, { docs: contextDocs });
    const reviewResult = await runStandardReview(createModel(inputs), systemPrompt, userPrompt);

    core.info(
      `Review done. tokens in=${reviewResult.inputTokens} out=${reviewResult.outputTokens} tot=${reviewResult.totalTokens} steps=${reviewResult.steps}`,
    );

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
