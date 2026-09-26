import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getRawInputs } from './inputs';

const REQUIRED: Record<string, string> = {
  'INPUT_API-KEY': 'sk-test',
  'INPUT_GITHUB-TOKEN': 'ghp_test',
};

const OPTIONAL_DEFAULTS: Record<string, string> = {
  'INPUT_TRIGGER-COMMENT': '',
  'INPUT_TRIGGER-LABEL': '',
  'INPUT_AUTO-REVIEW': 'false',
  'INPUT_MAX-FILES': '',
  'INPUT_MAX-DIFF-LINES': '',
  'INPUT_USE-DEFAULT-EXCLUDES': 'true',
  'INPUT_REVIEW-MODE': '',
  'INPUT_AGENT-TARBALL-MAX-MB': '',
  'INPUT_PI-VERSION': '',
  'INPUT_PI-TIMEOUT-MS': '',
  'INPUT_API-TYPE': '',
  'INPUT_BASE-URL': '',
  INPUT_MODEL: '',
  'INPUT_APP-TOKEN-URL': '',
};

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of [...Object.keys(REQUIRED), ...Object.keys(OPTIONAL_DEFAULTS)]) {
    savedEnv[k] = process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setEnv(overrides: Record<string, string> = {}): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('INPUT_')) delete process.env[k];
  }
  for (const [k, v] of Object.entries({ ...REQUIRED, ...OPTIONAL_DEFAULTS, ...overrides })) {
    process.env[k] = v;
  }
}

describe('getRawInputs', () => {
  it('returns raw inputs with workflow-only defaults', () => {
    setEnv();
    const raw = getRawInputs();
    expect(raw).toMatchObject({
      apiKey: 'sk-test',
      githubToken: 'ghp_test',
      triggerComment: '/reviewally',
      triggerLabel: 'reviewally',
      autoReview: 'false',
      maxFiles: 20,
      maxDiffLines: 3000,
      useDefaultExcludes: true,
      agentTarballMaxMb: 200,
      piVersion: '0.87.1',
      piTimeoutMs: 600000,
      apiType: undefined,
      baseUrl: undefined,
      model: undefined,
      reviewMode: undefined,
    });
  });

  it('reads variable-resolvable knobs as raw strings without validation', () => {
    setEnv({
      'INPUT_API-TYPE': 'not-a-real-type',
      INPUT_MODEL: 'some-model',
      'INPUT_REVIEW-MODE': 'AGENT',
      'INPUT_BASE-URL': 'https://x/v1',
    });
    const raw = getRawInputs();
    expect(raw.apiType).toBe('not-a-real-type');
    expect(raw.model).toBe('some-model');
    expect(raw.reviewMode).toBe('agent');
    expect(raw.baseUrl).toBe('https://x/v1');
  });

  it('throws on non-numeric max-files', () => {
    setEnv({ 'INPUT_MAX-FILES': 'abc' });
    expect(() => getRawInputs()).toThrow(/Invalid max-files/);
  });

  it('throws on negative max-files', () => {
    setEnv({ 'INPUT_MAX-FILES': '-5' });
    expect(() => getRawInputs()).toThrow(/Invalid max-files/);
  });

  it('throws on non-numeric pi-timeout-ms', () => {
    setEnv({ 'INPUT_PI-TIMEOUT-MS': 'forever' });
    expect(() => getRawInputs()).toThrow(/Invalid pi-timeout-ms/);
  });

  it('throws on pi-version with shell metacharacters', () => {
    setEnv({ 'INPUT_PI-VERSION': '0.87.1; rm -rf /' });
    expect(() => getRawInputs()).toThrow(/Invalid pi-version/);
  });

  it('accepts semver, prerelease, and dist-tag pi-versions', () => {
    for (const v of ['0.82.1', '1.0.0-rc.1', 'latest', 'next']) {
      setEnv({ 'INPUT_PI-VERSION': v });
      expect(getRawInputs().piVersion).toBe(v);
    }
  });

  it('accepts an https app-token-url', () => {
    setEnv({ 'INPUT_APP-TOKEN-URL': 'https://api.reviewally.nethbotheju.dev/token' });
    expect(getRawInputs().appTokenUrl).toBe('https://api.reviewally.nethbotheju.dev/token');
  });

  it('rejects an http app-token-url (token would leak in cleartext)', () => {
    setEnv({ 'INPUT_APP-TOKEN-URL': 'http://api.reviewally.nethbotheju.dev/token' });
    expect(() => getRawInputs()).toThrow(/app-token-url.*https/);
  });

  it('rejects a malformed app-token-url', () => {
    setEnv({ 'INPUT_APP-TOKEN-URL': 'not a url' });
    expect(() => getRawInputs()).toThrow(/Invalid app-token-url/);
  });
});
