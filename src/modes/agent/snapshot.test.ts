import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { c as tarCreate } from 'tar';
import { downloadTarball, type OctokitLike } from '../../github/api';
import {
  buildRepoTree,
  cleanupRepoSnapshot,
  prepareRepoSnapshot,
  RepoTooLargeError,
} from './snapshot';

vi.mock('../../github/api', () => ({ downloadTarball: vi.fn() }));

function createFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/utils'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
  fs.writeFileSync(path.join(dir, 'src/index.ts'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(dir, 'src/utils/auth.ts'), 'export const TOKEN = "abc";\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  return dir;
}

describe('buildRepoTree', () => {
  it('excludes default patterns and dotfiles', () => {
    const dir = createFixtureDir();
    try {
      const inputs = { useDefaultExcludes: true, excludePatterns: [] as string[] };
      const tree = buildRepoTree(dir, inputs, 200);
      expect(tree).toContain('src/');
      expect(tree).toContain('src/index.ts');
      expect(tree).toContain('src/utils/');
      expect(tree).toContain('src/utils/auth.ts');
      expect(tree).toContain('package.json');
      expect(tree).toContain('README.md');
      expect(tree).not.toContain('node_modules/');
      expect(tree).not.toContain('.git/');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates when exceeding max entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tree-test-'));
    try {
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(path.join(dir, `file${i}.ts`), '');
      }
      const inputs = { useDefaultExcludes: false, excludePatterns: [] as string[] };
      const tree = buildRepoTree(dir, inputs, 10);
      expect(tree).toContain('truncated');
      expect(tree.split('\n').length).toBeLessThan(30);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters out extra exclude patterns', () => {
    const dir = createFixtureDir();
    try {
      const inputs = { useDefaultExcludes: false, excludePatterns: ['docs/**'] as string[] };
      const tree = buildRepoTree(dir, inputs);
      expect(tree).not.toContain('docs/');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not follow symlinks when generating the repository tree', () => {
    const dir = createFixtureDir();
    try {
      fs.symlinkSync(path.dirname(dir), path.join(dir, 'outside'));
      const tree = buildRepoTree(dir, { useDefaultExcludes: false, excludePatterns: [] });
      expect(tree).not.toContain('outside');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes dotfiles when not excluded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotfile-test-'));
    try {
      fs.writeFileSync(path.join(dir, '.github'), '');
      const inputs = { useDefaultExcludes: false, excludePatterns: [] as string[] };
      const tree = buildRepoTree(dir, inputs, 200);
      expect(tree).toContain('.github');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepareRepoSnapshot', () => {
  async function withArchive(
    create: (root: string) => void,
    run: (octokit: OctokitLike) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-archive-test-'));
    try {
      const repo = path.join(dir, 'project');
      fs.mkdirSync(repo);
      create(repo);
      const archivePath = path.join(dir, 'archive.tar.gz');
      await tarCreate({ gzip: true, file: archivePath, cwd: dir }, ['project']);
      vi.mocked(downloadTarball).mockResolvedValue({
        buffer: fs.readFileSync(archivePath),
        contentLengthMb: null,
      });
      await run({} as OctokitLike);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not extract symlinks from an untrusted archive', async () => {
    await withArchive(
      (repo) => {
        fs.writeFileSync(path.join(repo, 'safe.ts'), 'export {};');
        fs.symlinkSync('/etc/passwd', path.join(repo, 'escape'));
      },
      async (octokit) => {
        const snapshot = await prepareRepoSnapshot(octokit, 'o', 'r', 'sha', 5);
        try {
          expect(fs.existsSync(path.join(snapshot.path, 'safe.ts'))).toBe(true);
          expect(fs.existsSync(path.join(snapshot.path, 'escape'))).toBe(false);
        } finally {
          cleanupRepoSnapshot(snapshot);
        }
      },
    );
  });

  it('rejects archives that expand well beyond the compressed-size cap', async () => {
    await withArchive(
      (repo) => {
        fs.writeFileSync(path.join(repo, 'zeros.bin'), Buffer.alloc(1024 * 1024));
      },
      async (octokit) => {
        await expect(prepareRepoSnapshot(octokit, 'o', 'r', 'sha', 0.1)).rejects.toBeInstanceOf(
          RepoTooLargeError,
        );
      },
    );
  });
});

describe('RepoTooLargeError', () => {
  it('creates error with correct message', () => {
    const err = new RepoTooLargeError(150, 100);
    expect(err.name).toBe('RepoTooLargeError');
    expect(err.message).toContain('150MB');
    expect(err.message).toContain('100MB');
  });
});
