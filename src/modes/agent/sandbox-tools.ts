import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RepoRoot } from '../../config/types';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

const MAX_READ_BYTES = 1024 * 1024;
const MAX_RESULTS = 100;

export function containedPath(root: string, relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('~') ||
    relativePath.startsWith('@') ||
    relativePath.includes('\\') ||
    relativePath.includes('\0')
  ) {
    throw new Error('Only relative paths within the repository snapshot are allowed.');
  }
  const canonicalRoot = fs.realpathSync(root);
  const canonicalTarget = fs.realpathSync(path.resolve(root, relativePath));
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path escapes the repository snapshot.');
  }
  return canonicalTarget;
}

export function createSandboxTools(sdk: PiSdk, root: RepoRoot): ToolDefinition[] {
  const read = sdk.createReadTool(root.path);
  const grep = sdk.createGrepTool(root.path);
  const find = sdk.createFindTool(root.path);
  const ls = sdk.createLsTool(root.path);

  return [
    sdk.defineTool({
      ...read,
      async execute(id, params, signal, onUpdate) {
        const file = containedPath(root.path, params.path);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
          throw new Error('File is not a supported text/image file within the size limit.');
        }
        return read.execute(id, params, signal, onUpdate);
      },
    }),
    sdk.defineTool({
      ...grep,
      async execute(id, params, signal, onUpdate) {
        containedPath(root.path, params.path ?? '.');
        if (params.pattern.length > 500 || (params.glob?.length ?? 0) > 500) {
          throw new Error('Search pattern exceeds the limit.');
        }
        return grep.execute(
          id,
          { ...params, limit: Math.min(params.limit ?? MAX_RESULTS, MAX_RESULTS) },
          signal,
          onUpdate,
        );
      },
    }),
    sdk.defineTool({
      ...find,
      async execute(id, params, signal, onUpdate) {
        containedPath(root.path, params.path ?? '.');
        if (params.pattern.length > 500) throw new Error('Find pattern exceeds the limit.');
        return find.execute(
          id,
          { ...params, limit: Math.min(params.limit ?? MAX_RESULTS, MAX_RESULTS) },
          signal,
          onUpdate,
        );
      },
    }),
    sdk.defineTool({
      ...ls,
      async execute(id, params, signal, onUpdate) {
        containedPath(root.path, params.path ?? '.');
        return ls.execute(
          id,
          { ...params, limit: Math.min(params.limit ?? MAX_RESULTS, MAX_RESULTS) },
          signal,
          onUpdate,
        );
      },
    }),
  ];
}
