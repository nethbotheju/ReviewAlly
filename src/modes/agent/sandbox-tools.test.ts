import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piSdk from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { containedPath, createSandboxTools } from './sandbox-tools';

function withSnapshot(run: (root: string, outside: string) => Promise<void>) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-path-test-'));
  const root = path.join(workDir, 'repo');
  const outside = path.join(workDir, 'private.txt');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'auth.ts'), 'export const auth = true;');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(root, 'leak'));
  return run(root, outside).finally(() => fs.rmSync(workDir, { recursive: true, force: true }));
}

describe('pi built-in repository tool boundary', () => {
  it('rejects absolute paths, traversal, prefixed paths and symlink escapes', async () => {
    await withSnapshot(async (root, outside) => {
      expect(containedPath(root, 'auth.ts')).toBe(fs.realpathSync(path.join(root, 'auth.ts')));
      for (const input of [outside, '../private.txt', 'leak', '@/etc/passwd', '~/secret']) {
        expect(() => containedPath(root, input)).toThrow();
      }
    });
  });

  it('uses pi built-ins but blocks reads and searches outside the snapshot', async () => {
    await withSnapshot(async (directory, outside) => {
      const repoRoot = { path: directory, workDir: path.dirname(directory) };
      const tools = createSandboxTools(piSdk, repoRoot);
      const read = tools.find((tool) => tool.name === 'read')!;
      const grep = tools.find((tool) => tool.name === 'grep')!;
      const find = tools.find((tool) => tool.name === 'find')!;
      const ls = tools.find((tool) => tool.name === 'ls')!;
      const content = await read.execute(
        '1',
        { path: 'auth.ts' },
        undefined,
        undefined,
        {} as never,
      );
      expect(content.content[0]).toMatchObject({ text: 'export const auth = true;' });
      await expect(
        read.execute('2', { path: outside }, undefined, undefined, {} as never),
      ).rejects.toThrow();
      await expect(
        read.execute('3', { path: 'leak' }, undefined, undefined, {} as never),
      ).rejects.toThrow();
      await expect(
        grep.execute('4', { path: '..', pattern: 'secret' }, undefined, undefined, {} as never),
      ).rejects.toThrow();
      await expect(
        find.execute('5', { path: '..', pattern: '*' }, undefined, undefined, {} as never),
      ).rejects.toThrow();
      await expect(
        ls.execute('6', { path: '..' }, undefined, undefined, {} as never),
      ).rejects.toThrow();
    });
  });
});
