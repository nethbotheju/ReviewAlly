import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRoot } from '../../config/types';
import type { FetchResult } from '../../shared/types';
import type { AgentInvestigation, CandidateFinding } from './review-tools';
import { validateAgentFindings } from './findings';

const candidate: CandidateFinding = {
  path: 'src/auth.ts',
  line: 2,
  severity: 'high',
  title: 'Expiry is skipped',
  impact: 'Expired sessions remain active.',
  evidencePath: 'src/guard.ts',
  evidenceLine: 1,
  evidence: 'The caller delegates expiry checking to auth.',
  suggestedFix: 'Check expiry first.',
};
const fetchResult: FetchResult = {
  files: [
    {
      filename: 'src/auth.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      lines: [
        { type: 'context', newLine: 1, content: 'const auth = () => {' },
        { type: 'delete', content: '  return checkExpiry();' },
        { type: 'add', newLine: 2, content: '  return session.user;' },
      ],
    },
  ],
  totalFiles: 1,
  reviewedFiles: 1,
  truncated: false,
};

function makeInvestigation(findings: CandidateFinding[]): AgentInvestigation {
  return {
    findings,
    assessment: { summary: 'Review complete.', limitations: [] },
    openedDiffs: [],
  };
}

function withSnapshot(run: (root: RepoRoot) => void): void {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewally-findings-test-'));
  const root = { path: path.join(workDir, 'repo'), workDir };
  fs.mkdirSync(path.join(root.path, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root.path, 'src/auth.ts'),
    'const auth = () => {\n  return session.user;\n',
  );
  fs.writeFileSync(path.join(root.path, 'src/guard.ts'), 'checkExpiry(session);\n');
  try {
    run(root);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

describe('validateAgentFindings', () => {
  it('turns evidence-backed added-line findings into replyable inline comments', () => {
    withSnapshot((root) => {
      const { comments, rejected } = validateAgentFindings(
        makeInvestigation([candidate]),
        fetchResult,
        root,
      );
      expect(rejected).toEqual([]);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ path: 'src/auth.ts', line: 2, side: 'RIGHT' });
      expect(comments[0]?.body).toContain('Evidence: `src/guard.ts:1`');
      expect(comments[0]?.body).toContain('Suggested fix: Check expiry first.');
    });
  });

  it('drops invalid, duplicate, and stale positions rather than publishing them', () => {
    withSnapshot((root) => {
      const result = validateAgentFindings(
        makeInvestigation([
          candidate,
          candidate,
          { ...candidate, line: 1 },
          { ...candidate, path: 'not-in-pr.ts' },
        ]),
        fetchResult,
        root,
      );
      expect(result.comments).toHaveLength(1);
      expect(result.rejected).toHaveLength(3);
      fs.writeFileSync(
        path.join(root.path, 'src/auth.ts'),
        'const auth = () => {\n  return checkExpiry();\n',
      );
      const stale = validateAgentFindings(makeInvestigation([candidate]), fetchResult, root);
      expect(stale.comments).toEqual([]);
      expect(stale.rejected[0]?.reason).toContain('does not match');
    });
  });

  it('rejects missing or out-of-root evidence', () => {
    withSnapshot((root) => {
      const outside = path.join(root.workDir, 'secret');
      fs.writeFileSync(outside, 'secret');
      fs.symlinkSync(outside, path.join(root.path, 'src/link'));
      const result = validateAgentFindings(
        makeInvestigation([
          { ...candidate, evidencePath: 'src/missing.ts' },
          { ...candidate, evidencePath: 'src/link' },
        ]),
        fetchResult,
        root,
      );
      expect(result.comments).toHaveLength(0);
      expect(result.rejected).toHaveLength(2);
    });
  });
});
