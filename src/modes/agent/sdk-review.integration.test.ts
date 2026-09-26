import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piSdk from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';
import type { ActionInputs } from '../../config/types';
import type { FetchResult } from '../../shared/types';
import { validateAgentFindings } from './findings';
import { formatAgentReview } from './format-review';
import { runSdkInvestigation } from './sdk-review';

it('runs the real pi SDK tool loop against a local mock model', async () => {
  vi.stubEnv('REVIEWALLY_AGENT_TRACE', 'false');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-llm-test-'));
  const repoRoot = { path: path.join(directory, 'repo'), workDir: directory };
  fs.mkdirSync(path.join(repoRoot.path, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot.path, 'src/auth.ts'),
    'export function auth() {\n  return session.user;\n}\n',
  );
  const calls = [
    { name: 'read', args: { path: 'src/auth.ts' } },
    { name: 'get_diff', args: { path: 'src/auth.ts' } },
    {
      name: 'submit_finding',
      args: {
        path: 'src/auth.ts',
        line: 2,
        title: 'Missing expiry check',
        severity: 'medium',
        impact: 'Expired sessions may authenticate.',
        evidencePath: 'src/auth.ts',
        evidenceLine: 2,
        evidence: 'The return bypasses an expiry guard.',
        suggestedFix: 'Verify expiry before returning.',
      },
    },
    {
      name: 'finish_review',
      args: {
        summary: 'Found one expiry issue.',
        limitations: ['Tests were not run.'],
        fileSummaries: [{ path: 'src/auth.ts', description: 'Changes the session return path.' }],
      },
    },
  ];
  let requests = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    const call = calls[requests++];
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta: Record<string, unknown>, finishReason: string | null) => {
      response.write(
        `data: ${JSON.stringify({
          id: `completion-${requests}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    };
    if (call) {
      send(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${requests}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
        null,
      );
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'Review complete.' }, null);
      send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No mock-model port.');
    const inputs = {
      apiType: 'openai-chat-compatible',
      apiKey: 'test-only',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'mock-model',
      piTimeoutMs: 12000,
    } as ActionInputs;
    const result: FetchResult = {
      files: [
        {
          filename: 'src/auth.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          lines: [
            { type: 'context', newLine: 1, content: 'export function auth() {' },
            { type: 'delete', content: '  return checkExpiry(session);' },
            { type: 'add', newLine: 2, content: '  return session.user;' },
            { type: 'context', newLine: 3, content: '}' },
          ],
        },
      ],
      totalFiles: 1,
      reviewedFiles: 1,
      truncated: false,
    };
    const investigation = await runSdkInvestigation(
      { number: 1, title: 'Auth', body: 'Fix session auth', headSha: 'head' },
      result,
      repoRoot,
      inputs,
      undefined,
      { sdk: piSdk, typeBox: Type },
    );
    expect(requests).toBe(5);
    expect(investigation.findings).toMatchObject([{ title: 'Missing expiry check', line: 2 }]);
    expect(investigation.assessment?.summary).toBe('Found one expiry issue.');
    expect(investigation.assessment?.fileSummaries).toEqual([
      { path: 'src/auth.ts', description: 'Changes the session return path.' },
    ]);
    expect(investigation.openedDiffs).toEqual(['src/auth.ts']);
    const validated = validateAgentFindings(investigation, result, repoRoot);
    expect(validated.comments).toMatchObject([{ path: 'src/auth.ts', line: 2, side: 'RIGHT' }]);
    const body = formatAgentReview(
      { number: 1, title: 'Auth', body: null, headSha: 'head' },
      result,
      investigation,
      validated,
    );
    expect(body).toContain('Review walkthrough');
    expect(body).toContain('Changes the session return path.');
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
