import { describe, it, expect } from 'vitest';
import { annotatePatch } from './patch';

describe('annotatePatch', () => {
  it('returns empty for an empty patch', () => {
    expect(annotatePatch('')).toEqual([]);
  });

  it('ignores text before the first hunk header', () => {
    const patch = `diff --git a/a.ts b/a.ts
index 1234..5678 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3`;
    const out = annotatePatch(patch);
    expect(out).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, content: 'line1' },
      { type: 'delete', oldLine: 2, content: 'old' },
      { type: 'add', newLine: 2, content: 'new' },
      { type: 'context', oldLine: 3, newLine: 3, content: 'line3' },
    ]);
  });

  it('tracks new-line numbers across hunks', () => {
    const patch = `@@ -10,2 +10,2 @@
 a
-b
+B
@@ -50,2 +51,2 @@
 c
-d
+D`;
    const out = annotatePatch(patch);
    expect(out[0]).toEqual({ type: 'context', oldLine: 10, newLine: 10, content: 'a' });
    expect(out[1]).toEqual({ type: 'delete', oldLine: 11, content: 'b' });
    expect(out[2]).toEqual({ type: 'add', newLine: 11, content: 'B' });
    expect(out[3]).toEqual({ type: 'context', oldLine: 50, newLine: 51, content: 'c' });
    expect(out[4]).toEqual({ type: 'delete', oldLine: 51, content: 'd' });
    expect(out[5]).toEqual({ type: 'add', newLine: 52, content: 'D' });
  });

  it('numbers delete lines by old file only, adds by new file only', () => {
    const patch = `@@ -1,3 +1,2 @@
 kept
-removed
+new line`;
    const out = annotatePatch(patch);
    expect(out[0]).toEqual({ type: 'context', oldLine: 1, newLine: 1, content: 'kept' });
    expect(out[1]).toEqual({ type: 'delete', oldLine: 2, content: 'removed' });
    expect(out[1]).not.toHaveProperty('newLine');
    expect(out[2]).toEqual({ type: 'add', newLine: 2, content: 'new line' });
    expect(out[2]).not.toHaveProperty('oldLine');
  });

  it('skips "\ No newline at end of file" markers', () => {
    const patch = `@@ -1,2 +1,2 @@
 a
-b
+B
\\ No newline at end of file`;
    const out = annotatePatch(patch);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ type: 'add', newLine: 2, content: 'B' });
  });

  it('handles a hunk header with no count', () => {
    const patch = `@@ -0,0 +1 @@
+added`;
    const out = annotatePatch(patch);
    expect(out).toEqual([{ type: 'add', newLine: 1, content: 'added' }]);
  });
  it('handles a context line without leading space', () => {
    const patch = `@@ -1,1 +1,1 @@
bare`;
    const out = annotatePatch(patch);
    expect(out[0]).toEqual({ type: 'context', oldLine: 1, newLine: 1, content: 'bare' });
  });
});
