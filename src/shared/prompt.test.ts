import { describe, it, expect } from 'vitest';
import type { ActionInputs, ApiType, ReviewMode } from '../config/types';
import type { PromptContext } from './prompt';
import { buildAgentSystemPrompt, buildSystemPrompt, buildUserPrompt } from './prompt';
import type { ChangedFile } from '../shared/types';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiType: 'openai' as ApiType,
    apiKey: 'sk-test',
    model: 'gpt-4o',
    githubToken: 'token',
    triggerComment: '/reviewally',
    triggerLabel: 'reviewally',
    autoReview: true,
    maxFiles: 20,
    maxDiffLines: 3000,
    excludePatterns: [],
    useDefaultExcludes: true,
    reviewMode: 'standard' as ReviewMode,
    agentTarballMaxMb: 200,
    contextDocs: ['AGENTS.md'],
    piVersion: '0.82.1',
    piTimeoutMs: 600000,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('produces standard prompt by default', () => {
    const inputs = makeInputs();
    const prompt = buildSystemPrompt(inputs);
    expect(prompt).toContain('You are a senior software engineer');
    expect(prompt).not.toContain('AGENT MODE');
    expect(prompt).toContain('recommendations');
    expect(prompt).toContain('background');
  });

  it('specifies strict JSON syntax and a fenced template', () => {
    const prompt = buildSystemPrompt(makeInputs());
    expect(prompt).toContain('never single quotes');
    expect(prompt).toContain('```json');
    expect(prompt).toContain('Use exactly this response template');
  });

  it('includes extra instructions when provided', () => {
    const inputs = makeInputs({ extraInstructions: 'Use functional style.' });
    const prompt = buildSystemPrompt(inputs);
    expect(prompt).toContain('Use functional style');
  });

  it('does not emit agent-specific content (agent mode has its own builder)', () => {
    const inputs = makeInputs({ reviewMode: 'agent' });
    const prompt = buildSystemPrompt(inputs);
    expect(prompt).not.toContain('AGENT MODE');
    expect(prompt).not.toContain('operating inside pi');
  });

  it('includes extra instructions regardless of review mode', () => {
    const inputs = makeInputs({ reviewMode: 'agent', extraInstructions: 'Focus on security.' });
    const prompt = buildSystemPrompt(inputs);
    expect(prompt).toContain('Focus on security');
    expect(prompt).not.toContain('AGENT MODE');
  });
});

describe('buildAgentSystemPrompt', () => {
  it('is built on pi agent-harness framing with the read-only tools listed', () => {
    const prompt = buildAgentSystemPrompt(makeInputs({ reviewMode: 'agent' }));
    expect(prompt).toContain('expert coding assistant operating inside pi');
    expect(prompt).toContain('- read: Read file contents');
    expect(prompt).toContain('- grep: Search file contents for patterns');
    expect(prompt).toContain('- find: Find files by glob pattern');
    expect(prompt).toContain('- ls: List directory contents');
    expect(prompt).toContain('read-only tools only');
  });

  it('lists the ReviewAlly review tools and their contract', () => {
    const prompt = buildAgentSystemPrompt(makeInputs({ reviewMode: 'agent' }));
    expect(prompt).toContain('- get_diff:');
    expect(prompt).toContain('- submit_finding:');
    expect(prompt).toContain('- finish_review:');
    expect(prompt).toContain('anchored to an ADDED line');
    expect(prompt).toContain('Recording does not post anything');
    expect(prompt).toContain('exactly once');
  });

  it('requires verified findings and a tool-driven workflow, not JSON output', () => {
    const prompt = buildAgentSystemPrompt(makeInputs({ reviewMode: 'agent' }));
    expect(prompt).toContain('verify it by reading the relevant file');
    expect(prompt).toContain('introduced or exposed by this PR');
    // the final message is prose — the JSON contract is gone
    expect(prompt).not.toContain('fenced json code block');
    expect(prompt).not.toContain('```json');
    expect(prompt).not.toContain('never single quotes');
    expect(prompt).toContain('never a JSON object');
  });

  it('omits pi-internal docs/themes/skills guidance irrelevant to a review', () => {
    const prompt = buildAgentSystemPrompt(makeInputs({ reviewMode: 'agent' }));
    expect(prompt).not.toContain('Pi documentation');
    expect(prompt).not.toContain('themes');
    expect(prompt).not.toContain('skills');
  });

  it('injects extra instructions before the output contract', () => {
    const prompt = buildAgentSystemPrompt({
      ...makeInputs({ reviewMode: 'agent' }),
      extraInstructions: 'Focus on SQL injection.',
    });
    const instrIdx = prompt.indexOf('Focus on SQL injection');
    const outputIdx = prompt.indexOf('Output format:');
    expect(instrIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(instrIdx);
  });
});

describe('buildUserPrompt', () => {
  const mockPr = { number: 42, title: 'Add feature X', body: 'This PR adds feature X.' };
  const mockFiles: ChangedFile[] = [
    {
      filename: 'src/index.ts',
      status: 'modified',
      additions: 10,
      deletions: 2,
      lines: [
        { type: 'context', newLine: 1, content: '// old code' },
        { type: 'add', newLine: 2, content: '// new feature' },
        { type: 'delete', content: '// removed line' },
      ],
    },
  ];

  it('includes PR title and description', () => {
    const result = buildUserPrompt(mockPr, mockFiles);
    expect(result).toContain('# Pull Request #42: Add feature X');
    expect(result).toContain('This PR adds feature X');
    expect(result).toContain('src/index.ts');
  });

  it('prepends the tool-driven review directive in agent mode', () => {
    const result = buildUserPrompt(mockPr, mockFiles, undefined, true);
    expect(result.startsWith('Review the pull request below')).toBe(true);
    expect(result).toContain('get_diff');
    expect(result).toContain('submit_finding');
    expect(result).toContain('finish_review');
    expect(result).toContain('not JSON');
  });

  it('omits the tool directive in standard mode', () => {
    const result = buildUserPrompt(mockPr, mockFiles);
    expect(result).not.toContain('Investigate the repository with your tools');
    expect(result.startsWith('# Pull Request')).toBe(true);
  });

  it('includes diff content', () => {
    const result = buildUserPrompt(mockPr, mockFiles);
    expect(result).toContain('+');
    expect(result).toContain('-');
    expect(result).toContain('// old code');
    expect(result).toContain('// new feature');
  });

  it('includes repository tree when provided', () => {
    const ctx: PromptContext = { tree: '  src/\n  src/index.ts\n  README.md' };
    const result = buildUserPrompt(mockPr, mockFiles, ctx);
    expect(result).toContain('Repository Layout');
    expect(result).toContain('src/index.ts');
  });

  it('includes project guidance when provided', () => {
    const ctx: PromptContext = { docs: '## AGENTS.md\n\nUse TypeScript.' };
    const result = buildUserPrompt(mockPr, mockFiles, ctx);
    expect(result).toContain('Project Guidance');
    expect(result).toContain('Use TypeScript');
  });

  it('handles missing description', () => {
    const result = buildUserPrompt({ number: 1, title: 'Fix', body: null }, mockFiles);
    expect(result).not.toContain('Description');
    expect(result).toContain('Fix');
  });
});
