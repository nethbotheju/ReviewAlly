import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as core from '@actions/core';
import type { ActionInputs, RepoRoot } from '../../config/types';
import type { FetchResult, ReviewResult } from '../../shared/types';
import { buildModelsJson, buildPiArgs, buildPiEnv, providerFor } from './pi-args';
import { ensurePiInstalled, invokePi } from './pi-process';
import { parsePiOutput } from './pi-output';
import { buildDiffsPayload, collectAgentToolCalls, type AgentToolCalls } from './tools';
import { extensionSource } from './extension-source';

export const EXTENSION_FILE = 'reviewally-tools.js';
export const DIFFS_FILE = 'diffs.json';

export interface AgentRunResult extends ReviewResult {
  toolCalls: AgentToolCalls;
}

/**
 * Run the agent-mode review: install the pi subprocess, write an ephemeral
 * config dir (models.json for openai-chat-compatible, the ReviewAlly tools
 * extension and its diff data), spawn the CLI against the repo snapshot, and
 * parse its JSONL event stream into a review result plus collected tool calls.
 */
export async function runAgentReview(
  systemPrompt: string,
  userPrompt: string,
  repoRoot: RepoRoot,
  inputs: ActionInputs,
  fetch: FetchResult,
): Promise<AgentRunResult> {
  const cliEntry = await ensurePiInstalled(inputs.piVersion);

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-'));
  try {
    if (inputs.apiType === 'openai-chat-compatible') {
      fs.writeFileSync(
        path.join(configDir, 'models.json'),
        JSON.stringify(buildModelsJson(inputs), null, 2),
      );
    }

    const extensionPath = path.join(configDir, EXTENSION_FILE);
    fs.writeFileSync(extensionPath, extensionSource());
    const diffsFile = path.join(configDir, DIFFS_FILE);
    fs.writeFileSync(diffsFile, JSON.stringify(buildDiffsPayload(fetch)));

    const args = buildPiArgs(systemPrompt, userPrompt, inputs, extensionPath);
    const env = buildPiEnv(inputs, configDir, diffsFile);

    core.info(
      `pi engine: provider=${providerFor(inputs)} model=${inputs.model} ` +
        `timeout=${inputs.piTimeoutMs}ms`,
    );

    const { events, stderr } = await invokePi(
      cliEntry,
      args,
      repoRoot.path,
      env,
      inputs.piTimeoutMs,
    );

    if (stderr.trim()) {
      core.warning(`pi stderr (truncated):\n${stderr.trim().slice(0, 2000)}`);
    }

    const toolCalls = collectAgentToolCalls(events);

    // Findings come from tool calls, so a missing final message is not fatal
    // when the tools recorded results; otherwise surface the parse failure.
    let base: ReviewResult;
    try {
      base = parsePiOutput(events);
    } catch (err) {
      if (toolCalls.finish || toolCalls.findings.length > 0 || toolCalls.diffCalls > 0) {
        base = {
          text: '',
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          steps: events.filter((e) => e.type === 'turn_end').length,
        };
      } else {
        throw err;
      }
    }

    return { ...base, toolCalls };
  } finally {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
