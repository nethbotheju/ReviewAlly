import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { context } from '@actions/github';
import { resolveTrigger } from './trigger';
import type { ActionInputs } from '../config/types';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiType: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o',
    githubToken: 'ghp_test',
    triggerComment: '/reviewally',
    triggerLabel: 'reviewally',
    autoReview: false,
    maxFiles: 20,
    maxDiffLines: 3000,
    excludePatterns: [],
    useDefaultExcludes: true,
    reviewMode: 'standard',
    agentTarballMaxMb: 200,
    contextDocs: [],
    piVersion: '0.82.1',
    piTimeoutMs: 600000,
    piLog: 'compact',
    ...overrides,
  };
}

let originalEventName: string;
let originalPayload: unknown;
let originalRepoDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalEventName = context.eventName;
  originalPayload = context.payload;
  originalRepoDescriptor = Object.getOwnPropertyDescriptor(context, 'repo');
});

afterEach(() => {
  context.eventName = originalEventName;
  context.payload = originalPayload as typeof context.payload;
  if (originalRepoDescriptor) {
    Object.defineProperty(context, 'repo', originalRepoDescriptor);
  }
});

function setContext(
  eventName: string,
  payload: Record<string, unknown>,
  repo: { owner: string; repo: string },
) {
  context.eventName = eventName;
  context.payload = payload as typeof context.payload;
  Object.defineProperty(context, 'repo', { value: repo, configurable: true });
}

describe('resolveTrigger', () => {
  it('returns run:false on unsupported events', () => {
    setContext('push', {}, { owner: 'o', repo: 'r' });
    const r = resolveTrigger(makeInputs());
    expect(r.run).toBe(false);
    expect(r.reason).toMatch(/Unsupported event/);
  });

  it('skips pull_request with no payload', () => {
    setContext('pull_request', {}, { owner: 'o', repo: 'r' });
    const r = resolveTrigger(makeInputs());
    expect(r.run).toBe(false);
    expect(r.reason).toMatch(/no pull_request payload/);
  });

  it('skips when auto-review is off and action is not labeled', () => {
    setContext(
      'pull_request',
      { action: 'opened', pull_request: { number: 1 } },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs({ autoReview: false }));
    expect(r.run).toBe(false);
    expect(r.reason).toMatch(/auto-review is disabled/);
  });

  it('runs on labeled when the trigger label matches', () => {
    setContext(
      'pull_request',
      { action: 'labeled', label: { name: 'reviewally' }, pull_request: { number: 42 } },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs({ triggerLabel: 'reviewally' }));
    expect(r.run).toBe(true);
    expect(r.review).toEqual({ owner: 'o', repo: 'r', pullNumber: 42 });
  });

  it('skips labeled when the label does not match', () => {
    setContext(
      'pull_request',
      { action: 'labeled', label: { name: 'something-else' }, pull_request: { number: 1 } },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs({ triggerLabel: 'reviewally' }));
    expect(r.run).toBe(false);
    expect(r.reason).toMatch(/is not the trigger label/);
  });

  it('runs on opened when auto-review is on', () => {
    setContext(
      'pull_request',
      { action: 'opened', pull_request: { number: 7 } },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs({ autoReview: true }));
    expect(r.run).toBe(true);
    expect(r.review?.pullNumber).toBe(7);
  });

  it('skips comments that are not on a PR', () => {
    setContext(
      'issue_comment',
      { action: 'created', issue: { number: 1 }, comment: { body: '/reviewally', id: 99 } },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs());
    expect(r.run).toBe(false);
    expect(r.reason).toMatch(/not on a pull request/);
  });

  it('skips comments that do not start with the trigger', () => {
    setContext(
      'issue_comment',
      {
        action: 'created',
        issue: { number: 1, pull_request: {} },
        comment: { body: 'looks good', id: 99 },
      },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs({ triggerComment: '/reviewally' }));
    expect(r.run).toBe(false);
    expect(r.reason).toMatch(/does not start with/);
  });

  it('runs on a matching issue_comment (case-insensitive)', () => {
    setContext(
      'issue_comment',
      {
        action: 'created',
        issue: { number: 5, pull_request: {} },
        comment: { body: '/ReviewAlly please', id: 42 },
      },
      { owner: 'o', repo: 'r' },
    );
    const r = resolveTrigger(makeInputs({ triggerComment: '/reviewally' }));
    expect(r.run).toBe(true);
    expect(r.review).toEqual({ owner: 'o', repo: 'r', pullNumber: 5, commentId: 42 });
  });
});
