import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXTENSION_SOURCE_B64, extensionSource } from './extension-source';

const DIFFS_FILE_ENV = 'REVIEWALLY_DIFFS_FILE';

let tmpDir: string;
let diffsFile: string;
let oldCwd: string;

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: Record<string, unknown>,
    ...rest: unknown[]
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function makeExtensionApi(tools: RegisteredTool[]) {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    setActiveTools: vi.fn(),
    setThinkingLevel: vi.fn(),
    sendMessage: vi.fn(),
  };
}

async function loadFreshExtension(tools: RegisteredTool[]) {
  vi.resetModules();
  const mod = (await import('./reviewally-tools.js')) as {
    default: (pi: ReturnType<typeof makeExtensionApi>) => void;
  };
  const pi = makeExtensionApi(tools);
  mod.default(pi);
  return pi;
}

async function run(tool: RegisteredTool, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute('call-1', params);
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function makeFile(
  pathName: string,
  lines: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return { path: pathName, status: 'modified', additions: 2, deletions: 1, lines, ...extra };
}

const FILE_A = makeFile('src/a.ts', [
  { type: 'context', oldLine: 1, newLine: 1, content: 'ctx' },
  { type: 'delete', oldLine: 2, content: 'old line' },
  { type: 'add', newLine: 2, content: 'new line' },
]);

const FINDING = {
  path: 'src/a.ts',
  line: 2,
  title: 'Unbounded index',
  severity: 'high',
  impact: 'Lookup can go out of range',
  evidencePath: 'src/a.ts',
  evidenceLine: 2,
  evidence: 'Index never checked',
  suggestedFix: 'Clamp before use',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-tools-'));
  diffsFile = path.join(tmpDir, 'diffs.json');
  fs.writeFileSync(
    diffsFile,
    JSON.stringify({ truncated: false, totalFiles: 1, reviewedFiles: 1, files: [FILE_A] }),
  );
  process.env[DIFFS_FILE_ENV] = diffsFile;
  // The extension resolves evidence paths against the process cwd, which pi
  // sets to the repo snapshot — emulate that with a real file on disk.
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), `${'line\n'.repeat(10)}`);
  oldCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.REVIEWALLY_TIMEOUT_MS;
  delete process.env[DIFFS_FILE_ENV];
  process.chdir(oldCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('embedded extension source', () => {
  it('stays in sync with the canonical reviewally-tools.js', async () => {
    const canonical = fs.readFileSync(path.join(__dirname, 'reviewally-tools.js'), 'utf8');
    expect(Buffer.from(EXTENSION_SOURCE_B64, 'base64').toString('utf8')).toBe(canonical);
    expect(extensionSource()).toBe(canonical);
  });

  it('decodes to runnable JavaScript that registers the tools', async () => {
    const tools: RegisteredTool[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-embed-'));
    try {
      const file = path.join(dir, 'reviewally-tools.js');
      fs.writeFileSync(file, extensionSource());
      vi.resetModules();
      process.env[DIFFS_FILE_ENV] = diffsFile;
      const mod = (await import(/* @vite-ignore */ file)) as {
        default: (pi: ReturnType<typeof makeExtensionApi>) => void;
      };
      mod.default(makeExtensionApi(tools));
      expect(tools.map((t) => t.name).sort()).toEqual([
        'finish_review',
        'get_diff',
        'submit_finding',
      ]);
    } finally {
      delete process.env[DIFFS_FILE_ENV];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extension registration', () => {
  it('registers exactly the three ReviewAlly tools with object schemas', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'finish_review',
      'get_diff',
      'submit_finding',
    ]);
    for (const t of tools) {
      expect(t.parameters).toHaveProperty('type', 'object');
      expect(t.parameters).toHaveProperty('properties');
    }
  });
});

describe('get_diff', () => {
  it('returns the first page with old/new line numbers and an end marker', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;
    const text = await run(getDiff, { path: 'src/a.ts' });
    expect(text).toContain('src/a.ts — modified, +2 -1, patch lines 1-3 of 3');
    expect(text).toContain('     1      1   ctx');
    expect(text).toContain('     2        - old line');
    expect(text).toContain('            2 + new line');
    expect(text).toContain('more: no — end of patch');
  });

  it('pages through a long patch and reports the next offset while more remain', async () => {
    const lines = Array.from({ length: 450 }, (_, i) => ({
      type: 'add',
      newLine: i + 1,
      content: `line ${i + 1}`,
    }));
    fs.writeFileSync(
      diffsFile,
      JSON.stringify({
        truncated: false,
        totalFiles: 1,
        reviewedFiles: 1,
        files: [makeFile('big.ts', lines, { additions: 450, deletions: 0 })],
      }),
    );
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;

    const first = await run(getDiff, { path: 'big.ts' });
    expect(first).toContain('patch lines 1-200 of 450');
    expect(first).toContain('more: yes — call get_diff again with path="big.ts" offset=201');

    const second = await run(getDiff, { path: 'big.ts', offset: 201 });
    expect(second).toContain('patch lines 201-400 of 450');
    expect(second).toContain('more: yes');

    const last = await run(getDiff, { path: 'big.ts', offset: 401 });
    expect(last).toContain('patch lines 401-450 of 450');
    expect(last).toContain('more: no — end of patch');
  });

  it('rejects unknown paths and lists the inspectable files', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;
    await expect(run(getDiff, { path: 'nope.ts' })).rejects.toThrow(
      /"nope\.ts" is not among the changed files in this review.+Changed files: src\/a\.ts\./,
    );
    await expect(run(getDiff, { path: 'nope.ts' })).rejects.toThrow(
      /use read\/grep on the repository snapshot/,
    );
  });

  it('discloses truncated file selection when rejecting unknown paths', async () => {
    fs.writeFileSync(
      diffsFile,
      JSON.stringify({
        truncated: true,
        totalFiles: 9,
        reviewedFiles: 1,
        files: [FILE_A],
      }),
    );
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;
    await expect(run(getDiff, { path: 'nope.ts' })).rejects.toThrow(
      /truncated \(1 of 9 changed files are inspectable\)/,
    );
  });

  it('rejects invalid offsets explicitly with the valid range', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;
    await expect(run(getDiff, { path: 'src/a.ts', offset: 0 })).rejects.toThrow(
      /Invalid offset 0 .* between 1 and 3/,
    );
    await expect(run(getDiff, { path: 'src/a.ts', offset: 4 })).rejects.toThrow(
      /Invalid offset 4 .* between 1 and 3/,
    );
    await expect(run(getDiff, { path: 'src/a.ts', offset: 1.5 })).rejects.toThrow(
      /Invalid offset 1\.5/,
    );
  });

  it('rejects an empty or incomplete patch explicitly', async () => {
    fs.writeFileSync(
      diffsFile,
      JSON.stringify({
        truncated: false,
        totalFiles: 1,
        reviewedFiles: 1,
        files: [makeFile('e.ts', [])],
      }),
    );
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;
    await expect(run(getDiff, { path: 'e.ts' })).rejects.toThrow(/empty or incomplete/);
  });

  it('fails closed when no diff data was provided', async () => {
    delete process.env[DIFFS_FILE_ENV];
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const getDiff = tools.find((t) => t.name === 'get_diff')!;
    await expect(run(getDiff, { path: 'src/a.ts' })).rejects.toThrow(/REVIEWALLY_DIFFS_FILE/);
  });
});

describe('submit_finding', () => {
  it('records a finding anchored to an added line without posting', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    const text = await run(submit, FINDING);
    expect(text).toContain('Recorded finding #1 at src/a.ts:2 (high)');
    expect(text).toContain('nothing is posted yet');
  });

  it('rejects duplicate locations', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    await run(submit, FINDING);
    await expect(run(submit, FINDING)).rejects.toThrow(/already recorded at src\/a\.ts:2/);
  });

  it('rejects anchors that are not added lines', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    await expect(run(submit, { ...FINDING, line: 1 })).rejects.toThrow(
      /Line 1 of "src\/a\.ts" is not an added line/,
    );
    await expect(run(submit, { ...FINDING, line: 999 })).rejects.toThrow(
      /Line 999 of "src\/a\.ts" is not an added line/,
    );
  });

  it('rejects paths outside the review selection', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    await expect(run(submit, { ...FINDING, path: 'other.ts' })).rejects.toThrow(
      /"other\.ts" is not among the changed files/,
    );
  });

  it('rejects evidence lines that are out of range, with guidance to re-submit', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    await expect(run(submit, { ...FINDING, evidenceLine: 999 })).rejects.toThrow(
      /evidenceLine 999 is out of range for "src\/a\.ts" \(1-11\)\. Verify the exact line with read or grep, then re-submit/,
    );
  });

  it('rejects evidence files that do not exist in the snapshot', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    await expect(run(submit, { ...FINDING, evidencePath: 'gone.ts' })).rejects.toThrow(
      /evidence file "gone\.ts" was not found in the repository snapshot/,
    );
  });

  it('enforces the finding cap', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      type: 'add',
      newLine: i + 1,
      content: `line ${i + 1}`,
    }));
    fs.writeFileSync(
      diffsFile,
      JSON.stringify({
        truncated: false,
        totalFiles: 1,
        reviewedFiles: 1,
        files: [makeFile('many.ts', lines, { additions: 30, deletions: 0 })],
      }),
    );
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const submit = tools.find((t) => t.name === 'submit_finding')!;
    for (let i = 0; i < 25; i++) {
      const text = await run(submit, { ...FINDING, path: 'many.ts', line: i + 1 });
      expect(text).toContain(`#${i + 1}`);
    }
    await expect(run(submit, { ...FINDING, path: 'many.ts', line: 26 })).rejects.toThrow(
      /Finding limit reached/,
    );
  });
});

describe('investigation budget', () => {
  it('reserves the last 30% for reporting and sends one steering message', async () => {
    vi.useFakeTimers();
    process.env.REVIEWALLY_TIMEOUT_MS = '10000';
    const pi = await loadFreshExtension([]);
    pi.handlers.get('session_start')!();
    vi.advanceTimersByTime(6999);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.setActiveTools).toHaveBeenCalledWith(['submit_finding', 'finish_review']);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith('low');
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'reviewally_budget',
        content: expect.stringContaining('call finish_review immediately'),
      }),
      { deliverAs: 'steer', triggerTurn: true },
    );
    vi.advanceTimersByTime(10000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not steer a review that already finished', async () => {
    vi.useFakeTimers();
    process.env.REVIEWALLY_TIMEOUT_MS = '10000';
    const tools: RegisteredTool[] = [];
    const pi = await loadFreshExtension(tools);
    pi.handlers.get('session_start')!();
    await run(
      tools.find((tool) => tool.name === 'finish_review')!,
      { summary: 'Done' },
    );
    vi.advanceTimersByTime(10000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    await expect(
      run(
        tools.find((tool) => tool.name === 'submit_finding')!,
        FINDING,
      ),
    ).rejects.toThrow(/already complete/);
  });

  it.each(['agent_settled', 'session_shutdown'])('clears the timer on %s', async (event) => {
    vi.useFakeTimers();
    process.env.REVIEWALLY_TIMEOUT_MS = '10000';
    const pi = await loadFreshExtension([]);
    pi.handlers.get('session_start')!();
    pi.handlers.get(event)!();
    vi.advanceTimersByTime(10000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the deadline across agent runs that may retry', async () => {
    vi.useFakeTimers();
    process.env.REVIEWALLY_TIMEOUT_MS = '10000';
    const pi = await loadFreshExtension([]);
    pi.handlers.get('session_start')!();
    pi.handlers.get('agent_end')?.();
    vi.advanceTimersByTime(7000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'invalid', '0', '-1'])('ignores invalid timeout %j', async (timeout) => {
    vi.useFakeTimers();
    process.env.REVIEWALLY_TIMEOUT_MS = timeout;
    const pi = await loadFreshExtension([]);
    pi.handlers.get('session_start')!();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('finish_review', () => {
  it('accepts summary, limitations, and file summaries once', async () => {
    const tools: RegisteredTool[] = [];
    await loadFreshExtension(tools);
    const finish = tools.find((t) => t.name === 'finish_review')!;
    const text = await run(finish, {
      summary: 'Looks good overall',
      limitations: ['could not run tests'],
      fileSummaries: [{ path: 'src/a.ts', description: 'small tweak' }],
    });
    expect(text).toContain('Review finished: 0 finding(s) recorded');
    await expect(run(finish, { summary: 'again' })).rejects.toThrow(/already called/);
  });
});
