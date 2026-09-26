import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { x as tarExtract } from 'tar';
import * as core from '@actions/core';
import { downloadTarball, type OctokitLike } from '../../github/api';
import { isExcluded, resolveExcludes } from '../../shared/util';
import type { ActionInputs, RepoRoot } from '../../config/types';

const MAX_TREE_ENTRIES = 200;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MB = 1024 * 1024;

/** Error thrown when the repo tarball exceeds the configured max size. */
export class RepoTooLargeError extends Error {
  constructor(sizeMb: number, maxMb: number) {
    super(
      `Repo tarball is ${sizeMb}MB, exceeding the ${maxMb}MB limit. Agent mode degraded to standard.`,
    );
    this.name = 'RepoTooLargeError';
  }
}

/**
 * Download and extract a tarball of the repo at a ref (via octokit, so GHE-aware).
 * Returns a RepoRoot pointing to the extracted directory.
 */
export async function prepareRepoSnapshot(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  ref: string,
  maxMb: number,
): Promise<RepoRoot> {
  core.info(`Downloading repo snapshot at ${ref}...`);

  const { buffer, contentLengthMb } = await downloadTarball(octokit, owner, repo, ref);

  if ((contentLengthMb != null && contentLengthMb > maxMb) || buffer.length > maxMb * MB) {
    throw new RepoTooLargeError(Math.round((buffer.length / MB) * 10) / 10, maxMb);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-'));
  try {
    const tarballPath = path.join(workDir, 'repo.tar.gz');
    fs.writeFileSync(tarballPath, buffer);

    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    let archiveEntries = 0;
    let expandedBytes = 0;
    let violation: Error | undefined;
    await tarExtract({
      file: tarballPath,
      C: extractDir,
      filter: (entryPath, entry) => {
        if (violation) return false;
        if (
          path.isAbsolute(entryPath) ||
          path.win32.isAbsolute(entryPath) ||
          entryPath.split(/[\\/]/).includes('..')
        ) {
          violation = new Error('Repository snapshot contains an unsafe archive path.');
          return false;
        }
        if ('type' in entry) {
          if (entry.type === 'SymbolicLink' || entry.type === 'Link') return false;
          if (entry.type !== 'File' && entry.type !== 'Directory') return false;
        } else if (!entry.isFile() && !entry.isDirectory()) {
          return false;
        }
        archiveEntries++;
        expandedBytes += entry.size;
        if (archiveEntries > MAX_ARCHIVE_ENTRIES || expandedBytes > maxMb * MB * 3) {
          violation = new RepoTooLargeError(Math.round((expandedBytes / MB) * 10) / 10, maxMb);
          return false;
        }
        return true;
      },
    });
    if (violation) throw violation;

    // GitHub tarballs extract to a single top-level directory like "owner-repo-sha/".
    const entries = fs.readdirSync(extractDir).filter((e) => !e.startsWith('.'));
    const topDir =
      entries.length === 1 && entries[0] !== undefined
        ? path.join(extractDir, entries[0])
        : extractDir;

    core.info(`Repo snapshot extracted to ${topDir}`);
    return { path: topDir, workDir };
  } catch (err) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Remove the repo snapshot temp directory. */
export function cleanupRepoSnapshot(root: RepoRoot): void {
  try {
    fs.rmSync(root.workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Build a compact file-tree representation of the repo for the prompt. */
export function buildRepoTree(
  root: string,
  inputs: Pick<ActionInputs, 'useDefaultExcludes' | 'excludePatterns'>,
  maxEntries: number = MAX_TREE_ENTRIES,
): string {
  const excludes = resolveExcludes(inputs);
  const entries: string[] = ['  .'];
  let count = 0;
  const stack: Array<{ dir: string; prefix: string }> = [{ dir: root, prefix: '' }];

  while (stack.length > 0 && count < maxEntries) {
    const frame = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(frame.dir);
    } catch (err) {
      core.debug(`Skipping unreadable directory ${frame.dir}: ${(err as Error).message}`);
      continue;
    }

    names.sort();
    for (const name of names) {
      if (count >= maxEntries) break;

      const fullPath = path.join(frame.dir, name);
      const relPath = frame.prefix ? `${frame.prefix}/${name}` : name;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      // Check excludes; test trailing slash for directories so `**/node_modules/**` matches the dir itself.
      if (isExcluded(relPath, excludes)) continue;

      if (stat.isDirectory()) {
        entries.push(`  ${relPath}/`);
        count++;
        stack.push({ dir: fullPath, prefix: relPath });
      } else {
        entries.push(`  ${relPath}`);
        count++;
      }
    }
  }

  if (count >= maxEntries) {
    entries.push(`  … (truncated at ${maxEntries} entries)`);
  }

  return entries.join('\n');
}
