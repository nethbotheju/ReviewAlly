import * as core from '@actions/core';
import type { PiLogLevel, PiThinkingLevel, RawActionInputs } from './types';

const DEFAULT_PI_VERSION = '1.0.0';
// Injection-safe version spec (semver, prerelease, dist-tag). No spaces/shell metachars.
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+\-]*$/;
const PI_LOG_LEVELS: readonly PiLogLevel[] = ['off', 'compact', 'full'];
const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function parseIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name} '${raw}'. Must be a non-negative integer.`);
  }
  return n;
}

function optionalInput(name: string): string | undefined {
  const raw = core.getInput(name).trim();
  return raw === '' ? undefined : raw;
}

function parsePiLogLevel(): PiLogLevel {
  const raw = optionalInput('pi-log')?.toLowerCase();
  if (raw === undefined) return 'compact';
  const level = PI_LOG_LEVELS.find((l) => l === raw);
  if (!level) {
    throw new Error(`Invalid pi-log '${raw}'. Must be one of: off, compact, full.`);
  }
  return level;
}

function parsePiThinking(): PiThinkingLevel {
  const raw = optionalInput('pi-thinking')?.toLowerCase();
  if (raw === undefined) return 'off';
  const level = PI_THINKING_LEVELS.find((l) => l === raw);
  if (!level) {
    throw new Error(
      `Invalid pi-thinking '${raw}'. Must be one of: off, minimal, low, medium, high, xhigh, max.`,
    );
  }
  return level;
}

export function getRawInputs(): RawActionInputs {
  const apiKey = core.getInput('api-key', { required: true });
  const githubToken = core.getInput('github-token', { required: true });

  let appTokenUrl = optionalInput('app-token-url');
  if (appTokenUrl) {
    let parsed: URL;
    try {
      parsed = new URL(appTokenUrl);
    } catch {
      throw new Error(`Invalid app-token-url '${appTokenUrl}'. Must be a valid URL.`);
    }
    if (parsed.protocol !== 'https:') {
      // The workflow GITHUB_TOKEN is sent to this endpoint; http:// would leak it in cleartext.
      throw new Error(
        `Invalid app-token-url '${appTokenUrl}'. Must be an https:// URL — the workflow token is sent to this endpoint.`,
      );
    }
    appTokenUrl = parsed.toString();
  }

  const piVersion = optionalInput('pi-version') ?? DEFAULT_PI_VERSION;
  if (!VERSION_PATTERN.test(piVersion)) {
    throw new Error(
      `Invalid pi-version '${piVersion}'. Must be a plain version or dist-tag (e.g. 1.0.0, latest).`,
    );
  }

  return {
    apiType: optionalInput('api-type'),
    apiKey,
    baseUrl: optionalInput('base-url'),
    model: optionalInput('model'),
    githubToken,
    appTokenUrl,
    triggerComment: optionalInput('trigger-comment') ?? '/reviewally',
    triggerLabel: optionalInput('trigger-label') ?? 'reviewally',
    autoReview: optionalInput('auto-review'),
    maxFiles: parseIntInput('max-files', 20),
    maxDiffLines: parseIntInput('max-diff-lines', 3000),
    useDefaultExcludes: core.getBooleanInput('use-default-excludes'),
    reviewMode: optionalInput('review-mode')?.toLowerCase(),
    agentTarballMaxMb: parseIntInput('agent-tarball-max-mb', 200),
    piVersion,
    piTimeoutMs: parseIntInput('pi-timeout-ms', 600000),
    piLog: parsePiLogLevel(),
    piThinking: parsePiThinking(),
  };
}
