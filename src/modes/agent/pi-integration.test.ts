import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { describe, it, expect } from 'vitest';
import type { ActionInputs } from '../../config/types';
import { buildModelsJson, buildPiArgs, buildPiEnv } from './pi-args';
import { invokePi } from './pi-process';
import { extensionSource } from './extension-source';
import { collectAgentToolCalls } from './tools';

const cliEntry = process.env.REVIEWALLY_TEST_PI_CLI;

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        index: 0,
        id: `call_${name}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

async function smokeRun(wrapUp: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-smoke-'));
  const requests: Array<{
    tools?: Array<{ function: { name: string } }>;
    messages: unknown[];
    reasoning_effort?: string;
  }> = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as (typeof requests)[number];
    requests.push(payload);
    const turn = requests.length;
    if (wrapUp && turn === 1) await new Promise((resolve) => setTimeout(resolve, 7300));
    const delta = wrapUp
      ? turn === 1
        ? { content: 'Still investigating.' }
        : turn === 2
          ? toolCall('finish_review', {
              summary: 'Reviewed available context.',
              limitations: ['Investigation time budget exhausted.'],
            })
          : { content: 'Done.' }
      : turn === 1
        ? toolCall('get_diff', { path: 'a.ts' })
        : turn === 2
          ? toolCall('submit_finding', {
              path: 'a.ts',
              line: 1,
              title: 'Verified smoke finding',
              severity: 'medium',
              impact: 'Test impact',
              evidencePath: 'a.ts',
              evidenceLine: 1,
              evidence: 'Test evidence',
              suggestedFix: 'Test fix',
            })
          : turn === 3
            ? toolCall('finish_review', { summary: 'Smoke review complete.' })
            : { content: 'Done.' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = {
      id: `completion_${turn}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'smoke',
    };
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const inputs: ActionInputs = {
      apiType: 'openai-chat-compatible',
      apiKey: 'fake-smoke-key',
      model: 'smoke',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      githubToken: '',
      triggerComment: '/reviewally',
      triggerLabel: 'reviewally',
      autoReview: false,
      maxFiles: 20,
      maxDiffLines: 3000,
      excludePatterns: [],
      useDefaultExcludes: true,
      reviewMode: 'agent',
      agentTarballMaxMb: 200,
      contextDocs: [],
      piVersion: 'test',
      piTimeoutMs: wrapUp ? 10000 : 30000,
      piLog: 'off',
      piThinking: wrapUp ? 'high' : 'low',
    };
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(buildModelsJson(inputs)));
    const extension = path.join(dir, 'reviewally-tools.js');
    fs.writeFileSync(extension, extensionSource());
    const diffs = path.join(dir, 'diffs.json');
    fs.writeFileSync(
      diffs,
      JSON.stringify({
        files: [
          {
            path: 'a.ts',
            status: 'added',
            additions: 1,
            deletions: 0,
            lines: [{ type: 'add', newLine: 1, content: 'const a = 1;' }],
          },
        ],
      }),
    );
    const system = path.join(dir, 'system.txt');
    const user = path.join(dir, 'user.txt');
    fs.writeFileSync(system, 'Review this change with the ReviewAlly tools.');
    fs.writeFileSync(user, 'Review a.ts.');
    const args = buildPiArgs(system, `@${user}`, inputs, extension);
    const result = await invokePi(
      cliEntry!,
      args,
      dir,
      buildPiEnv(inputs, dir, diffs),
      inputs.piTimeoutMs,
    );
    return { ...result, requests, calls: collectAgentToolCalls(result.events) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!cliEntry)('real pi CLI compatibility', () => {
  it('loads the extension, reads prompt files, and emits collectable review tool events', async () => {
    const result = await smokeRun(false);
    expect(result.timedOut).toBe(false);
    expect(result.calls.toolErrors).toEqual([]);
    expect(result.calls.inspectedPaths).toEqual(['a.ts']);
    expect(result.calls.findings).toHaveLength(1);
    expect(result.calls.finish?.summary).toBe('Smoke review complete.');
    expect(result.requests[0]?.reasoning_effort).toBe('low');
    expect(JSON.stringify(result.requests[0]?.messages)).toContain('Review a.ts.');
  }, 40000);

  it('steers a slow review into reporting before the hard timeout', async () => {
    const result = await smokeRun(true);
    expect(result.timedOut).toBe(false);
    expect(result.calls.finish?.summary).toBe('Reviewed available context.');
    expect(result.events.some((event) => event.message?.customType === 'reviewally_budget')).toBe(
      true,
    );
    expect(result.requests[1]?.reasoning_effort).toBe('low');
    expect(result.requests[1]?.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'finish_review',
      'submit_finding',
    ]);
  }, 20000);
});
