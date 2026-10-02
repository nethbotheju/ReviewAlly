import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInputs } from '../../config/types';
import { ensurePiInstalled, invokePi } from './pi-process';
import { runAgentReview } from './runner';

vi.mock('./pi-process', () => ({ ensurePiInstalled: vi.fn(), invokePi: vi.fn() }));
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

const inputs: ActionInputs = {
  apiType: 'openai',
  apiKey: 'secret',
  model: 'test',
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
  piVersion: '1.0.0',
  piTimeoutMs: 600000,
  piLog: 'off',
  piThinking: 'low',
};

let dir: string;
let previousTemp: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  previousTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = dir;
  vi.mocked(ensurePiInstalled).mockResolvedValue('/tmp/pi/cli.js');
});

afterEach(() => {
  if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
  else process.env.RUNNER_TEMP = previousTemp;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runAgentReview', () => {
  it.each([false, true])(
    'uses prompt files and detects budget-limited output (%s)',
    async (budgetLimited) => {
      const systemPrompt = 'system'.repeat(30000);
      const userPrompt = 'レビュー'.repeat(30000);
      let configDir = '';
      vi.mocked(invokePi).mockImplementation(async (_entry, args, cwd, env) => {
        const systemFile = args[args.indexOf('--system-prompt') + 1]!;
        const userFile = args.at(-1)!.slice(1);
        configDir = path.dirname(systemFile);
        expect(args.at(-1)).toMatch(/^@/);
        expect(fs.readFileSync(systemFile, 'utf8')).toBe(systemPrompt);
        expect(fs.readFileSync(userFile, 'utf8')).toBe(userPrompt);
        expect(args.every((arg) => Buffer.byteLength(arg) < 1000)).toBe(true);
        expect(cwd).toBe(dir);
        expect(env.REVIEWALLY_TIMEOUT_MS).toBe('600000');
        return {
          events: [
            ...(budgetLimited
              ? [
                  {
                    type: 'message_end',
                    message: {
                      role: 'custom',
                      customType: 'reviewally_budget',
                      content: 'Wrap up.',
                    },
                  },
                ]
              : []),
            {
              type: 'tool_execution_start',
              toolCallId: 'finish',
              toolName: 'finish_review',
              args: { summary: 'Done' },
            },
            {
              type: 'tool_execution_end',
              toolCallId: 'finish',
              toolName: 'finish_review',
              isError: false,
            },
            { type: 'message_end', message: { role: 'assistant', content: 'Done' } },
          ],
          stderr: '',
          timedOut: false,
        };
      });
      const result = await runAgentReview(
        systemPrompt,
        userPrompt,
        { path: dir, workDir: dir },
        inputs,
        {
          files: [],
          totalFiles: 0,
          reviewedFiles: 0,
          truncated: false,
        },
      );
      expect(result.budgetLimited).toBe(budgetLimited);
      expect(result.toolCalls.finish?.summary).toBe('Done');
      expect(fs.existsSync(configDir)).toBe(false);
      expect(fs.existsSync(path.join(dir, 'pi-transcript.jsonl'))).toBe(true);
    },
  );
});
