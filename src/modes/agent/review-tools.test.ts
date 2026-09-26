import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../shared/types';
import { createReviewToolKit } from './review-tools';

const changed: ChangedFile[] = [
  {
    filename: 'src/auth.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    lines: [
      { type: 'context', newLine: 9, content: 'function authenticate() {' },
      { type: 'delete', content: '  return checkExpiry(session);' },
      { type: 'add', newLine: 10, content: '  return session.user;' },
    ],
  },
];

const finding = {
  path: 'src/auth.ts',
  line: 10,
  title: 'Expired sessions remain valid',
  severity: 'high',
  impact: 'Revoked users may still authenticate.',
  evidencePath: 'src/auth.ts',
  evidenceLine: 10,
  evidence: 'This return bypasses the expiry check.',
  suggestedFix: 'Check expiry before returning the user.',
};

function invoke(
  tool: ReturnType<typeof createReviewToolKit>['tools'][number],
  input: Record<string, unknown>,
) {
  return tool.execute('call-1', input, undefined, undefined, {} as never);
}

describe('review agent tools', () => {
  it('returns a bounded diff with actual new-file line numbers', async () => {
    const kit = createReviewToolKit(Type, defineTool, changed);
    const diff = await invoke(kit.tools[0]!, { path: 'src/auth.ts' });
    expect(diff.content[0]).toMatchObject({
      text: expect.stringContaining('+    10 |   return session.user;'),
    });
    expect(kit.result().openedDiffs).toEqual(['src/auth.ts']);
    await expect(invoke(kit.tools[0]!, { path: 'not-in-pr.ts' })).rejects.toThrow(
      'No reviewable PR patch',
    );
  });

  it('records only candidates on added lines without posting anything', async () => {
    const kit = createReviewToolKit(Type, defineTool, changed);
    await expect(invoke(kit.tools[1]!, { ...finding, line: 9 })).rejects.toThrow('added line');
    await invoke(kit.tools[1]!, finding);
    expect(kit.result().findings).toEqual([finding]);
    await expect(invoke(kit.tools[1]!, finding)).rejects.toThrow('already been submitted');
  });

  it('records an assessment separately and closes the candidate collector', async () => {
    const kit = createReviewToolKit(Type, defineTool, changed);
    await invoke(kit.tools[2]!, { summary: 'One issue found.', limitations: ['Tests not run.'] });
    expect(kit.result().assessment).toEqual({
      summary: 'One issue found.',
      limitations: ['Tests not run.'],
    });
    await expect(invoke(kit.tools[1]!, finding)).rejects.toThrow('already finished');
  });

  it('pages large diffs instead of returning the entire patch', async () => {
    const large: ChangedFile[] = [
      {
        ...changed[0]!,
        lines: Array.from({ length: 125 }, (_, n) => ({
          type: 'add' as const,
          newLine: n + 1,
          content: `line ${n + 1}`,
        })),
      },
    ];
    const kit = createReviewToolKit(Type, defineTool, large);
    const first = await invoke(kit.tools[0]!, { path: 'src/auth.ts' });
    expect(first.content[0]).toMatchObject({ text: expect.stringContaining('offset=121') });
    expect(kit.result().completedDiffs).toEqual([]);
    const second = await invoke(kit.tools[0]!, { path: 'src/auth.ts', offset: 121 });
    expect(second.content[0]).toMatchObject({
      text: expect.stringContaining('+   125 | line 125'),
    });
    expect(kit.result().completedDiffs).toEqual(['src/auth.ts']);
  });
});
