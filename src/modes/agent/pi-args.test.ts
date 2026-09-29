import { describe, it, expect } from 'vitest';
import type { ActionInputs, ApiType, ReviewMode } from '../../config/types';
import {
  buildModelsJson,
  buildPiArgs,
  buildPiEnv,
  PI_CUSTOM_API_KEY_ENV,
  PI_CUSTOM_PROVIDER,
  providerFor,
} from './pi-args';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiType: 'anthropic' as ApiType,
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-5',
    githubToken: 'token',
    triggerComment: '/reviewally',
    triggerLabel: 'reviewally',
    autoReview: true,
    maxFiles: 20,
    maxDiffLines: 3000,
    excludePatterns: [],
    useDefaultExcludes: true,
    reviewMode: 'agent' as ReviewMode,
    agentTarballMaxMb: 200,
    contextDocs: ['AGENTS.md'],
    piVersion: '0.82.1',
    piTimeoutMs: 600000,
    piLog: 'compact',
    piThinking: 'off',
    ...overrides,
  };
}

const SYSTEM = 'SYSTEM';
const USER = 'USER';
const EXTENSION = '/tmp/cfg/reviewally-tools.js';

describe('providerFor', () => {
  it('maps native api types to their pi provider ids', () => {
    expect(providerFor(makeInputs({ apiType: 'anthropic' }))).toBe('anthropic');
    expect(providerFor(makeInputs({ apiType: 'openai' }))).toBe('openai');
  });

  it('maps openai-chat-compatible to the custom provider id', () => {
    expect(
      providerFor(makeInputs({ apiType: 'openai-chat-compatible', baseUrl: 'https://x/v1' })),
    ).toBe(PI_CUSTOM_PROVIDER);
  });
});

describe('buildModelsJson', () => {
  it('builds an openai-completions provider referencing the env key', () => {
    const json = buildModelsJson(
      makeInputs({
        apiType: 'openai-chat-compatible',
        apiKey: 'sk-x',
        baseUrl: 'https://gw.example.com/v1',
        model: 'my-model',
      }),
    ) as { providers: Record<string, Record<string, unknown>> };
    const provider = json.providers[PI_CUSTOM_PROVIDER];
    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBe('https://gw.example.com/v1');
    expect(provider?.api).toBe('openai-completions');
    expect(provider?.apiKey).toBe('$CUSTOM_API_KEY');
    // the plaintext secret must never appear in the generated config
    expect(JSON.stringify(json)).not.toContain('sk-x');
    const models = provider?.models as Array<{ id: string }> | undefined;
    expect(models?.[0]?.id).toBe('my-model');
  });

  it('opts out of developer role and reasoning knobs for max compatibility', () => {
    const json = buildModelsJson(
      makeInputs({ apiType: 'openai-chat-compatible', baseUrl: 'https://x/v1' }),
    ) as { providers: Record<string, { compat: Record<string, unknown> }> };
    const compat = json.providers[PI_CUSTOM_PROVIDER]?.compat as
      Record<string, unknown> | undefined;
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsReasoningEffort).toBe(false);
  });

  it('declares reasoning levels and sends reasoning_effort when a thinking level is set', () => {
    const json = buildModelsJson(
      makeInputs({
        apiType: 'openai-chat-compatible',
        baseUrl: 'https://x/v1',
        piThinking: 'low',
      }),
    ) as {
      providers: Record<
        string,
        {
          compat: Record<string, unknown>;
          models: Array<{
            id: string;
            reasoning?: boolean;
            thinkingLevelMap?: Record<string, string | null>;
          }>;
        }
      >;
    };
    const provider = json.providers[PI_CUSTOM_PROVIDER];
    expect(provider?.compat.supportsReasoningEffort).toBe(true);
    const model = provider?.models[0];
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap).toMatchObject({
      off: null,
      low: 'low',
      high: 'high',
      max: 'high',
    });
  });

  it('throws for non-compatible api types', () => {
    expect(() => buildModelsJson(makeInputs({ apiType: 'anthropic' }))).toThrow();
  });
});

describe('buildPiArgs', () => {
  it('always uses headless, ephemeral, read-only settings', () => {
    const args = buildPiArgs(SYSTEM, USER, makeInputs(), EXTENSION);
    expect(args).toContain('-p');
    expect(args).toContain('--no-session');
    expect(args[args.indexOf('--mode') + 1]).toBe('json');
    expect(args).toContain('--offline');
    expect(args[args.indexOf('--thinking') + 1]).toBe('off');
    const leveled = buildPiArgs(SYSTEM, USER, makeInputs({ piThinking: 'low' }), EXTENSION);
    expect(leveled[leveled.indexOf('--thinking') + 1]).toBe('low');
    expect(args[args.indexOf('--tools') + 1]).toBe(
      'read,grep,find,ls,get_diff,submit_finding,finish_review',
    );
    // read-only: never expose destructive tools
    expect(args.join(' ').replace(/get_diff,submit_finding,finish_review/, '')).not.toMatch(
      /\bbash\b|\bedit\b|\bwrite\b/,
    );
  });

  it('loads the ReviewAlly tools extension explicitly, before the system prompt', () => {
    const args = buildPiArgs(SYSTEM, USER, makeInputs(), EXTENSION);
    expect(args[args.indexOf('--extension') + 1]).toBe(EXTENSION);
    expect(args.indexOf('--extension')).toBeLessThan(args.indexOf('--system-prompt'));
    // explicit --extension paths load even under --no-extensions
    expect(args).toContain('--no-extensions');
  });

  it('passes provider + model + prompts', () => {
    const args = buildPiArgs(
      SYSTEM,
      USER,
      makeInputs({ apiType: 'anthropic', model: 'claude-x' }),
      EXTENSION,
    );
    expect(args[args.indexOf('--provider') + 1]).toBe('anthropic');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-x');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(SYSTEM);
    expect(args[args.length - 1]).toBe(USER);
  });

  it('uses the compatible provider id for openai-chat-compatible', () => {
    const args = buildPiArgs(
      SYSTEM,
      USER,
      makeInputs({ apiType: 'openai-chat-compatible', baseUrl: 'https://x/v1' }),
      EXTENSION,
    );
    expect(args[args.indexOf('--provider') + 1]).toBe(PI_CUSTOM_PROVIDER);
  });
});

describe('buildPiEnv', () => {
  it('injects the key via env and relocates the config dir', () => {
    const env = buildPiEnv(makeInputs({ apiType: 'anthropic', apiKey: 'sk-secret' }), '/tmp/cfg');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-secret');
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/cfg');
    expect(env.REVIEWALLY_DIFFS_FILE).toBeUndefined();
  });

  it('points the ReviewAlly extension at the diffs file when provided', () => {
    const env = buildPiEnv(
      makeInputs({ apiType: 'anthropic', apiKey: 'sk-secret' }),
      '/tmp/cfg',
      '/tmp/cfg/diffs.json',
    );
    expect(env.REVIEWALLY_DIFFS_FILE).toBe('/tmp/cfg/diffs.json');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-secret');
  });

  it('uses OPENAI_API_KEY for openai', () => {
    const env = buildPiEnv(makeInputs({ apiType: 'openai', apiKey: 'sk-openai' }), '/tmp/cfg');
    expect(env.OPENAI_API_KEY).toBe('sk-openai');
  });

  it('uses the compatible env var for openai-chat-compatible', () => {
    const env = buildPiEnv(
      makeInputs({ apiType: 'openai-chat-compatible', apiKey: 'sk-comp', baseUrl: 'https://x/v1' }),
      '/tmp/cfg',
    );
    expect(env[PI_CUSTOM_API_KEY_ENV]).toBe('sk-comp');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
