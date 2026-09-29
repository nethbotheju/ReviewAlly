import { describe, it, expect } from 'vitest';
import type { RawActionInputs } from './types';
import {
  CONFIG_VARIABLES,
  configSummaryRows,
  repoVariablesFromEnv,
  resolveInputs,
} from './variables';

function rawInputs(overrides: Partial<RawActionInputs> = {}): RawActionInputs {
  return {
    apiType: 'openai',
    apiKey: 'sk-test',
    baseUrl: undefined,
    model: 'gpt-4o',
    githubToken: 'ghp_test',
    appTokenUrl: undefined,
    triggerComment: '/reviewally',
    triggerLabel: 'reviewally',
    autoReview: 'false',
    maxFiles: 20,
    maxDiffLines: 3000,
    useDefaultExcludes: true,
    reviewMode: 'standard',
    agentTarballMaxMb: 200,
    piVersion: '0.82.1',
    piTimeoutMs: 600000,
    piLog: 'compact',
    piThinking: 'off',
    ...overrides,
  };
}

function vars(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('repoVariablesFromEnv', () => {
  it('reads known REVIEWALLY_* values and ignores unknown names', () => {
    const vars = repoVariablesFromEnv({
      REVIEWALLY_MODEL: 'deepseek-v4-flash',
      REVIEWALLY_SOMETHING_ELSE: 'ignored',
      UNRELATED: 'also-ignored',
    } as NodeJS.ProcessEnv);
    expect(vars.get('REVIEWALLY_MODEL')).toBe('deepseek-v4-flash');
    expect(vars.has('REVIEWALLY_SOMETHING_ELSE')).toBe(false);
    expect(vars.has('UNRELATED')).toBe(false);
  });

  it('trims values and treats blanks as unset (an unset variable forwards as empty)', () => {
    const vars = repoVariablesFromEnv({
      REVIEWALLY_MODEL: '  gpt-4o  ',
      REVIEWALLY_BASE_URL: '',
    } as NodeJS.ProcessEnv);
    expect(vars.get('REVIEWALLY_MODEL')).toBe('gpt-4o');
    expect(vars.has('REVIEWALLY_BASE_URL')).toBe(false);
  });
});

describe('resolveInputs', () => {
  it('prefers the workflow input over the repository variable', () => {
    const config = resolveInputs(rawInputs(), vars({ [CONFIG_VARIABLES.model]: 'other-model' }));
    expect(config.inputs.model).toBe('gpt-4o');
    expect(config.sources.model).toBe('workflow input');
  });

  it('fills an omitted input from the repository variable', () => {
    const config = resolveInputs(
      rawInputs({ model: undefined }),
      vars({ REVIEWALLY_MODEL: 'deepseek-v4-flash' }),
    );
    expect(config.inputs.model).toBe('deepseek-v4-flash');
    expect(config.sources.model).toBe('repo variable');
  });

  it('falls back to built-in defaults when neither input nor variable is set', () => {
    const config = resolveInputs(
      rawInputs({ reviewMode: undefined, autoReview: undefined }),
      vars(),
    );
    expect(config.inputs.reviewMode).toBe('standard');
    expect(config.sources.reviewMode).toBe('default');
    expect(config.inputs.autoReview).toBe(false);
    expect(config.sources.autoReview).toBe('default');
    expect(config.inputs.contextDocs).toEqual(['AGENTS.md', '.reviewally.md', 'CONTRIBUTING.md']);
    expect(config.inputs.extraInstructions).toBeUndefined();
    expect(config.inputs.excludePatterns).toEqual([]);
  });

  it('treats an empty-string variable as unset', () => {
    const config = resolveInputs(
      rawInputs({ reviewMode: undefined }),
      vars({ REVIEWALLY_REVIEW_MODE: '   ' }),
    );
    expect(config.inputs.reviewMode).toBe('standard');
    expect(config.sources.reviewMode).toBe('default');
  });

  it('reads the variable-only knobs exclusively from variables', () => {
    const config = resolveInputs(
      rawInputs(),
      vars({
        REVIEWALLY_EXTRA_INSTRUCTIONS: 'Flag SQL injection.',
        REVIEWALLY_CONTEXT_DOCS: 'docs/a.md, docs/b.md\ndocs/c.md',
        REVIEWALLY_EXCLUDE_PATTERNS: 'vendor/**, *.generated.ts',
      }),
    );
    expect(config.inputs.extraInstructions).toBe('Flag SQL injection.');
    expect(config.sources.extraInstructions).toBe('repo variable');
    expect(config.inputs.contextDocs).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
    expect(config.inputs.excludePatterns).toEqual(['vendor/**', '*.generated.ts']);
  });

  it('ignores unknown variables', () => {
    const config = resolveInputs(rawInputs(), vars({ REVIEWALLY_TOTALLY_NEW: 'x', OTHER: 'y' }));
    expect(config.inputs.model).toBe('gpt-4o');
  });

  it('throws when api-type is missing from both layers', () => {
    expect(() => resolveInputs(rawInputs({ apiType: undefined }), vars())).toThrow(
      /'api-type' is required.*REVIEWALLY_API_TYPE/s,
    );
  });

  it('throws when model is missing from both layers', () => {
    expect(() => resolveInputs(rawInputs({ model: undefined }), vars())).toThrow(
      /'model' is required.*REVIEWALLY_MODEL/s,
    );
  });

  it('validates api-type from a variable and names the variable in the error', () => {
    expect(() =>
      resolveInputs(rawInputs({ apiType: undefined }), vars({ REVIEWALLY_API_TYPE: 'bogus' })),
    ).toThrow(/Invalid api-type 'bogus' \(from repository variable REVIEWALLY_API_TYPE\)/);
  });

  it('validates api-type from an input without the variable mention', () => {
    expect(() => resolveInputs(rawInputs({ apiType: 'bogus' }), vars())).toThrow(
      /^Invalid api-type 'bogus'\./,
    );
  });

  it('validates review-mode from a variable (case-insensitive value)', () => {
    const config = resolveInputs(
      rawInputs({ reviewMode: undefined }),
      vars({ REVIEWALLY_REVIEW_MODE: 'Agent' }),
    );
    expect(config.inputs.reviewMode).toBe('agent');
    expect(() =>
      resolveInputs(
        rawInputs({ reviewMode: undefined }),
        vars({ REVIEWALLY_REVIEW_MODE: 'hybrid' }),
      ),
    ).toThrow(/Invalid review-mode 'hybrid' \(from repository variable REVIEWALLY_REVIEW_MODE\)/);
  });

  it('validates auto-review from a variable', () => {
    const config = resolveInputs(
      rawInputs({ autoReview: undefined }),
      vars({ REVIEWALLY_AUTO_REVIEW: 'TRUE' }),
    );
    expect(config.inputs.autoReview).toBe(true);
    expect(() =>
      resolveInputs(rawInputs({ autoReview: undefined }), vars({ REVIEWALLY_AUTO_REVIEW: 'yes' })),
    ).toThrow(/Invalid auto-review 'yes' \(from repository variable REVIEWALLY_AUTO_REVIEW\)/);
  });

  it('requires base-url for openai-chat-compatible across layers', () => {
    expect(() =>
      resolveInputs(
        rawInputs({ apiType: 'openai-chat-compatible', baseUrl: undefined }),
        vars({ REVIEWALLY_BASE_URL: '' }),
      ),
    ).toThrow(/'base-url' is required.*REVIEWALLY_BASE_URL/s);
  });

  it('accepts base-url from a variable for openai-chat-compatible', () => {
    const config = resolveInputs(
      rawInputs({ apiType: undefined, baseUrl: undefined }),
      vars({
        REVIEWALLY_API_TYPE: 'openai-chat-compatible',
        REVIEWALLY_BASE_URL: 'https://api.example.com/v1',
      }),
    );
    expect(config.inputs.apiType).toBe('openai-chat-compatible');
    expect(config.inputs.baseUrl).toBe('https://api.example.com/v1');
    expect(config.sources.apiType).toBe('repo variable');
    expect(config.sources.baseUrl).toBe('repo variable');
  });
});

describe('configSummaryRows', () => {
  it('emits a header plus one value+source row per knob', () => {
    const config = resolveInputs(
      rawInputs({ model: undefined, reviewMode: 'agent' }),
      vars({ REVIEWALLY_MODEL: 'deepseek-v4-flash' }),
    );
    const rows = configSummaryRows(config);
    expect(rows[0]).toEqual(['Setting', 'Value', 'Source']);
    const byLabel = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect(byLabel.get('model')).toEqual(['model', 'deepseek-v4-flash', 'repo variable']);
    expect(byLabel.get('review-mode')).toEqual(['review-mode', 'agent', 'workflow input']);
    expect(byLabel.get('auto-review')).toEqual(['auto-review', 'false', 'workflow input']);
    expect(byLabel.get('extra-instructions')).toEqual(['extra-instructions', '(none)', 'default']);
    expect(rows).toHaveLength(9);
  });

  it('collapses whitespace and truncates long values', () => {
    const config = resolveInputs(
      rawInputs(),
      vars({ REVIEWALLY_EXTRA_INSTRUCTIONS: `${'x'.repeat(100)}\n\nmore` }),
    );
    const rows = configSummaryRows(config);
    const extra = rows.find((r) => r[0] === 'extra-instructions')!;
    expect(extra[1]).toHaveLength(61);
    expect(extra[1]?.endsWith('…')).toBe(true);
    expect(extra[1]).not.toContain('\n');
  });
});
