import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invokePi, runNpm } from './pi-process';

function makeFakePi(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pi-'));
  const entry = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(entry, script);
  fs.chmodSync(entry, 0o755);
  return entry;
}

describe('invokePi', () => {
  let originalStderrSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalWarningSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    originalStderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    originalInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    originalWarningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    originalStderrSpy?.mockRestore();
    originalInfoSpy?.mockRestore();
    originalWarningSpy?.mockRestore();
  });

  it('parses well-formed JSONL events from the fake CLI', async () => {
    const script = `
      console.log(JSON.stringify({ type: 'turn_start' }));
      console.log(JSON.stringify({ type: 'turn_end', message: { role: 'assistant' } }));
      console.log(JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'review done' }] }],
      }));
    `;
    const cliEntry = makeFakePi(script);
    const { events } = await invokePi(cliEntry, [], os.tmpdir(), {}, 5000);
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe('turn_start');
    expect(events[1]?.type).toBe('turn_end');
    expect(events[2]?.type).toBe('agent_end');
  });

  it('skips non-JSON lines and lines without a type field', async () => {
    const script = `
      console.log('not json at all');
      console.log(JSON.stringify({ notAType: 'x' }));
      console.log(JSON.stringify({ type: 'turn_start' }));
      console.log('');
    `;
    const cliEntry = makeFakePi(script);
    const { events } = await invokePi(cliEntry, [], os.tmpdir(), {}, 5000);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('turn_start');
  });

  it('resolves with partial output when the fake CLI exits non-zero but emitted events', async () => {
    const script = `
      console.log(JSON.stringify({ type: 'turn_start' }));
      console.log(JSON.stringify({ type: 'turn_end' }));
      process.exit(2);
    `;
    const cliEntry = makeFakePi(script);
    const { events } = await invokePi(cliEntry, [], os.tmpdir(), {}, 5000);
    expect(events).toHaveLength(2);
  });

  it('rejects when the fake CLI exits non-zero and emitted no events', async () => {
    const script = `process.exit(1);`;
    const cliEntry = makeFakePi(script);
    await expect(invokePi(cliEntry, [], os.tmpdir(), {}, 5000)).rejects.toThrow(
      /exited with code 1/,
    );
  });

  it('resolves with partial events and timedOut=true when the fake CLI hangs', async () => {
    const script = `
      console.log(JSON.stringify({ type: 'turn_start' }));
      console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'get_diff', args: { path: 'a.ts' } }));
      setInterval(() => {}, 1000);
    `;
    const cliEntry = makeFakePi(script);
    const { events, timedOut } = await invokePi(cliEntry, [], os.tmpdir(), {}, 300);
    expect(timedOut).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'tool_execution_start']);
  }, 10000);

  it('streams every parsed event to the onEvent callback in order', async () => {
    const script = `
      console.log(JSON.stringify({ type: 'turn_start' }));
      console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'get_diff', args: { path: 'a.ts' } }));
      console.log(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'get_diff', isError: false }));
      console.log(JSON.stringify({ type: 'agent_end', messages: [] }));
    `;
    const cliEntry = makeFakePi(script);
    const seen: string[] = [];
    const { events } = await invokePi(cliEntry, [], os.tmpdir(), {}, 5000, (e) =>
      seen.push(e.type),
    );
    expect(seen).toEqual(events.map((e) => e.type));
    expect(seen).toEqual(['turn_start', 'tool_execution_start', 'tool_execution_end', 'agent_end']);
  });

  it('passes the working directory and environment to the child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoke-pi-'));
    fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'present');
    const script = `
      const fs = require('fs');
      const path = require('path');
      const cwd = process.cwd();
      const hasSentinel = fs.existsSync(path.join(cwd, 'sentinel.txt'));
      console.log(JSON.stringify({ type: 'cwd_check', hasSentinel, customKey: process.env.MY_CUSTOM_KEY || null }));
    `;
    const cliEntry = makeFakePi(script);
    const { events } = await invokePi(
      cliEntry,
      [],
      dir,
      { ...process.env, MY_CUSTOM_KEY: 'secret-value' } as NodeJS.ProcessEnv,
      5000,
    );
    const cwdEvent = events.find((e) => e.type === 'cwd_check') as
      { hasSentinel: boolean; customKey: string | null } | undefined;
    expect(cwdEvent?.hasSentinel).toBe(true);
    expect(cwdEvent?.customKey).toBe('secret-value');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes through the last line even if it lacks a trailing newline', async () => {
    const script = `process.stdout.write(JSON.stringify({ type: 'no_newline' }));`;
    const cliEntry = makeFakePi(script);
    const { events } = await invokePi(cliEntry, [], os.tmpdir(), {}, 5000);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('no_newline');
  });
});

describe('runNpm', () => {
  it('rejects with the captured stderr when the command exits non-zero', async () => {
    await expect(
      runNpm(
        [
          'exec',
          '--',
          'node',
          '-e',
          'process.stderr.write("EACCES: permission denied"); process.exit(1)',
        ],
        os.tmpdir(),
      ),
    ).rejects.toThrow(/exited with code 1/);
  }, 30000);

  it('rejects with a clear error on ENOENT (missing binary)', async () => {
    await expect(runNpm(['does-not-exist-xyz'], os.tmpdir())).rejects.toThrow();
  }, 30000);
});
