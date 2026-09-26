import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piSdk from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import type { ActionInputs, RepoRoot } from '../../config/types';
import { createReviewToolKit } from './review-tools';
import { PI_SDK_VERSION, sdkEntryPath } from './sdk-install';
import { createReviewAgentSession, createReviewResourceLoader, REVIEW_TOOLS } from './sdk-session';

const { createExtensionRuntime } = piSdk;

const inputs: Pick<ActionInputs, 'apiType' | 'apiKey' | 'baseUrl' | 'model'> = {
  apiType: 'openai',
  apiKey: 'test-only-key',
  model: 'gpt-4o',
};

async function withSnapshot(run: (root: RepoRoot) => Promise<void>): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-session-test-'));
  const repoRoot = { path: path.join(workDir, 'repo'), workDir };
  fs.mkdirSync(path.join(repoRoot.path, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot.path, 'AGENTS.md'), 'Untrusted project instructions');
  fs.writeFileSync(
    path.join(repoRoot.path, '.pi', 'settings.json'),
    JSON.stringify({ extensions: ['./malicious-extension.ts'] }),
  );
  try {
    await run(repoRoot);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

describe('pi SDK review session', () => {
  it('installs the same pinned version used during development', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies['@earendil-works/pi-coding-agent']).toBe(PI_SDK_VERSION);
    expect(sdkEntryPath()).toContain(path.join('reviewally-pi', PI_SDK_VERSION));
  });

  it('does not discover executable resources or context files from the reviewed repo', () => {
    const loader = createReviewResourceLoader('Review this PR', createExtensionRuntime);
    expect(loader.getSystemPrompt()).toBe('Review this PR');
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
  });

  it('opens an ephemeral session with only read-only built-in tools', async () => {
    await withSnapshot(async (root) => {
      const agent = await createReviewAgentSession(root, 'Review this PR', inputs, { sdk: piSdk });
      try {
        expect(agent.session.getActiveToolNames()).toEqual([...REVIEW_TOOLS]);
        expect(agent.session.systemPrompt).toContain('Review this PR');
        expect(agent.session.systemPrompt).not.toContain('Untrusted project instructions');
        expect(agent.session.model?.id).toBe('gpt-4o');
        await expect(
          agent.session
            .getToolDefinition('read')!
            .execute('call-1', { path: '/etc/passwd' }, undefined, undefined, {} as never),
        ).rejects.toThrow('Only relative paths');
      } finally {
        agent.dispose();
      }
    });
  });

  it('registers PR-specific tools alongside pi built-ins', async () => {
    await withSnapshot(async (root) => {
      const toolkit = createReviewToolKit(Type, piSdk.defineTool, []);
      const agent = await createReviewAgentSession(root, 'Review this PR', inputs, {
        sdk: piSdk,
        typeBox: Type,
        createTools: () => toolkit.tools,
      });
      try {
        expect(agent.session.getActiveToolNames()).toEqual([
          ...REVIEW_TOOLS,
          'get_diff',
          'submit_finding',
          'finish_review',
        ]);
      } finally {
        agent.dispose();
      }
    });
  });

  it('selects the configured Anthropic model without a network call', async () => {
    await withSnapshot(async (root) => {
      const agent = await createReviewAgentSession(
        root,
        'Review',
        { apiType: 'anthropic', apiKey: 'test-only-key', model: 'claude-sonnet-4-5' },
        { sdk: piSdk },
      );
      try {
        expect(agent.session.model?.provider).toBe('anthropic');
        expect(agent.session.model?.id).toBe('claude-sonnet-4-5');
      } finally {
        agent.dispose();
      }
    });
  });

  it('loads an OpenAI-compatible model without writing the key to models.json', async () => {
    await withSnapshot(async (root) => {
      const agent = await createReviewAgentSession(
        root,
        'Review',
        {
          apiType: 'openai-chat-compatible',
          apiKey: 'test-only-compatible-key',
          baseUrl: 'https://example.invalid/v1',
          model: 'my-model',
        },
        { sdk: piSdk },
      );
      try {
        expect(agent.session.model?.id).toBe('my-model');
        expect((await agent.session.modelRuntime.getAuth('custom'))?.auth.apiKey).toBe(
          'test-only-compatible-key',
        );
        expect(agent.session.getActiveToolNames()).toEqual([...REVIEW_TOOLS]);
      } finally {
        agent.dispose();
      }
    });
  });

  it('fails clearly for a model absent from the pi catalog', async () => {
    await withSnapshot(async (root) => {
      await expect(
        createReviewAgentSession(
          root,
          'Review',
          { ...inputs, model: 'not-a-real-model' },
          { sdk: piSdk },
        ),
      ).rejects.toThrow("Model 'not-a-real-model' is not available");
    });
  });
});
