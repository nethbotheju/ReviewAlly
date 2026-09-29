import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionInputs, ApiType } from '../../config/types';

vi.mock('@ai-sdk/openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-sdk/openai')>();
  return { ...actual, createOpenAI: vi.fn(actual.createOpenAI) };
});

import { createOpenAI } from '@ai-sdk/openai';
import { createModel } from './models';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiType: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o',
    githubToken: 'token',
    triggerComment: '/reviewally',
    triggerLabel: 'reviewally',
    autoReview: false,
    maxFiles: 20,
    maxDiffLines: 3000,
    excludePatterns: [],
    useDefaultExcludes: true,
    reviewMode: 'standard',
    agentTarballMaxMb: 200,
    contextDocs: ['AGENTS.md'],
    piVersion: '0.82.1',
    piTimeoutMs: 600000,
    piLog: 'compact',
    piThinking: 'off',
    ...overrides,
  };
}

describe('createModel', () => {
  const createOpenAISpy = vi.mocked(createOpenAI);
  beforeEach(() => createOpenAISpy.mockClear());

  function factoryConfig(call = 0): { headers?: Record<string, string> } {
    return (createOpenAISpy.mock.calls[call]?.[0] ?? {}) as { headers?: Record<string, string> };
  }
  // Regression guard: openai-chat-compatible MUST use the Chat Completions API,
  // not @ai-sdk/openai's default (Responses). Most compatible endpoints only
  // implement /chat/completions, so factory(model) -> /responses breaks them.
  it('routes openai-chat-compatible through chat completions', () => {
    const model = createModel(
      makeInputs({ apiType: 'openai-chat-compatible' as ApiType, baseUrl: 'https://x/v1' }),
    );
    expect((model as { provider: string }).provider).toBe('openai.chat');
  });

  it('keeps native openai on the Responses API', () => {
    expect((createModel(makeInputs({ apiType: 'openai' })) as { provider: string }).provider).toBe(
      'openai.responses',
    );
  });

  it('requires base-url for openai-chat-compatible', () => {
    expect(() => createModel(makeInputs({ apiType: 'openai-chat-compatible' as ApiType }))).toThrow(
      /base-url/,
    );
  });

  it('identifies ReviewAlly to chat-compatible endpoints', () => {
    createModel(
      makeInputs({
        apiType: 'openai-chat-compatible' as ApiType,
        baseUrl: 'https://api.groq.com/openai/v1',
      }),
    );
    expect(factoryConfig().headers?.['user-agent']).toBe('reviewally');
    expect(factoryConfig().headers?.['x-opencode-session']).toBeUndefined();
  });

  it('sends a session id to OpenCode Zen, which requires one per client policy', () => {
    createModel(
      makeInputs({
        apiType: 'openai-chat-compatible' as ApiType,
        baseUrl: 'https://opencode.ai/zen/go/v1',
      }),
    );
    expect(factoryConfig().headers?.['x-opencode-session']).toBeTruthy();
  });
});
