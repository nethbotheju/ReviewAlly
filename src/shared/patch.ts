import type { AnnotatedLine } from './types';

/** Parse a unified-diff patch into annotated lines (context/add/delete with old and new line numbers). */
export function annotatePatch(patch: string): AnnotatedLine[] {
  const result: AnnotatedLine[] = [];
  const raw = patch.split('\n');
  let currentOld = 0;
  let currentNew = 0;
  let inHunk = false;

  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const line of raw) {
    const hunk = hunkRe.exec(line);
    if (hunk && hunk[1] !== undefined && hunk[2] !== undefined) {
      currentOld = Number.parseInt(hunk[1], 10);
      currentNew = Number.parseInt(hunk[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      result.push({ type: 'add', newLine: currentNew, content: line.slice(1) });
      currentNew++;
    } else if (line.startsWith('-')) {
      result.push({ type: 'delete', oldLine: currentOld, content: line.slice(1) });
      currentOld++;
    } else if (line.startsWith('\\')) {
      continue;
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ type: 'context', oldLine: currentOld, newLine: currentNew, content });
      currentOld++;
      currentNew++;
    }
  }

  return result;
}
